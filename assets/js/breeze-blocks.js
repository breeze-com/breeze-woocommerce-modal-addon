/**
 * Breeze Modal Checkout — Blocks Integration
 *
 * Registers Breeze as a payment method with the WooCommerce Checkout Blocks
 * payment registry, then intercepts the "Place Order" flow to open a modal
 * instead of redirecting.
 *
 * How Blocks payment methods work:
 *  - registerPaymentMethod() tells Blocks this gateway exists on the front end
 *  - onPaymentSetup() runs when the customer clicks "Place Order" — returning
 *    { type: 'success' } lets Blocks proceed to create the order server-side,
 *    returning { type: 'error' } aborts with a message
 *  - After Blocks creates the order it calls the gateway's process_payment()
 *    server-side, which normally returns a redirect URL
 *  - We intercept that redirect URL via the onRedirect filter and open the
 *    modal instead of letting the browser follow it
 *
 * Because Blocks creates the order itself (unlike the legacy flow where we
 * had to call process_checkout() manually), the PHP side is simpler —
 * we only need to intercept the redirect that process_payment() returns.
 */

( function () {
	'use strict';

	var GATEWAY_ID    = 'breeze_payment_gateway';
	var MODAL_ID      = 'breeze-modal-overlay';
	var POLL_MS       = 150; // Fast poll — only active while modal is open
	var SUCCESS_EVENTS = [
		'payin_action_card_payment_success',
		'payin_action_apple_pay_payment_success',
		'payin_action_google_pay_payment_success',
	];

	/* ─────────────────────────────────────────────
	   State
	───────────────────────────────────────────── */
	var modalOpen        = false;
	var pollTimer        = null;
	var iframeEl         = null;
	var overlayEl        = null;
	var paymentConfirmed = false;

	/* ─────────────────────────────────────────────
	   Wait for Blocks registry to be available
	───────────────────────────────────────────── */
	function waitForRegistry( callback ) {
		if (
			window.wc &&
			window.wc.wcBlocksRegistry &&
			window.wc.wcBlocksRegistry.registerPaymentMethod
		) {
			callback();
		} else {
			setTimeout( function () { waitForRegistry( callback ); }, 50 );
		}
	}

	/* ─────────────────────────────────────────────
	   Register with WC Blocks
	───────────────────────────────────────────── */
	function registerBreezePaymentMethod() {
		var settings = window.breezeModalData || {};
		var gatewayData = settings.gatewayData || {};

		window.wc.wcBlocksRegistry.registerPaymentMethod( {
			name: GATEWAY_ID,

			// Label shown in the payment method list
			label: gatewayData.title || 'Breeze',

			// Content shown below the selected payment method
			content: window.wp && window.wp.element
				? window.wp.element.createElement(
					'p',
					{ style: { margin: '8px 0 0', fontSize: '14px', color: '#555' } },
					gatewayData.description || 'Pay securely using Breeze.'
				)
				: null,

			// Same content shown in edit mode (Block editor)
			edit: window.wp && window.wp.element
				? window.wp.element.createElement(
					'p',
					null,
					gatewayData.title || 'Breeze'
				)
				: null,

			// Whether this method can be used — mirrors PHP is_available()
			canMakePayment: function () {
				return !! gatewayData.enabled;
			},

			// Unique identifier must match the WC gateway ID exactly
			paymentMethodId: GATEWAY_ID,

			// Declare what this method supports
			supports: {
				features: gatewayData.supports || [ 'products' ],
			},
		} );
	}

	/* ─────────────────────────────────────────────
	   Intercept the redirect after order creation.
	
	   WC Blocks POSTs to /wp-json/wc/store/v1/checkout,
	   which calls process_payment() server-side and returns:
	     { payment_result: { payment_details: { redirect_url: '...' } } }
	
	   We hook into the store's checkout actions to catch the
	   redirect_url before the browser follows it.
	───────────────────────────────────────────── */
	function interceptBlocksRedirect() {
		// WC Blocks emits a custom event on the document when a payment
		// redirect is about to happen. We catch it here.
		document.addEventListener( 'wc-blocks_checkout_after_processing_with_errors', function () {
			// Let WC Blocks handle errors normally — only intercept success redirects.
		} );

		// The cleanest intercept point: wc/store checkout success fires an
		// event with the server response before navigating.
		document.addEventListener( '__experimentalCheckoutAfterProcessing', handleCheckoutSuccess );
		document.addEventListener( 'wc-blocks_checkout_order_processed', handleCheckoutSuccess );

		// Fallback: intercept any navigation to the Breeze payment URL by
		// watching XHR responses from the Store API.
		interceptStoreFetch();
	}

	function handleCheckoutSuccess( event ) {
		var detail = event && event.detail;
		if ( ! detail ) return;

		var redirectUrl = extractRedirectUrl( detail );
		if ( redirectUrl && isBreezePaymentUrl( redirectUrl ) ) {
			event.preventDefault && event.preventDefault();
			event.stopImmediatePropagation && event.stopImmediatePropagation();
			openModal( redirectUrl );
		}
	}

	/**
	 * Patches window.fetch to intercept the WC Store API checkout response
	 * and grab the Breeze redirect URL before the Blocks runtime follows it.
	 */
	function interceptStoreFetch() {
		var originalFetch = window.fetch;

		window.fetch = function ( input, init ) {
			var url = typeof input === 'string' ? input : ( input && input.url ) || '';

			// Only intercept WC Store API checkout endpoint
			var isCheckoutRequest = (
				url.indexOf( '/wc/store' ) !== -1 &&
				url.indexOf( 'checkout' ) !== -1
			);

			if ( ! isCheckoutRequest ) {
				return originalFetch.apply( this, arguments );
			}

			// Only intercept POST requests — the final submission.
			// Blocks also makes PUT requests to update order data (address changes etc.)
			// which don't have payment_result and shouldn't be consumed.
			var method = ( init && init.method ) ? init.method.toUpperCase() : 'GET';
			if ( method !== 'POST' ) {
				console.log( '[Breeze Modal] Skipping non-POST checkout request:', method, url );
				return originalFetch.apply( this, arguments );
			}

			console.log( '[Breeze Modal] Intercepting POST Store API checkout request:', url );

			return originalFetch.apply( this, arguments ).then( function ( response ) {
				// We must parse the body BEFORE returning to Blocks, then hand back
				// a synthetic Response with the redirect_url stripped out so Blocks
				// cannot navigate away before our modal opens.
				return response.json().then( function ( data ) {
					var redirectUrl = extractRedirectUrl( data );
					console.log( '[Breeze Modal] redirect_url found:', redirectUrl );

					if ( redirectUrl && isBreezePaymentUrl( redirectUrl ) ) {
						console.log( '[Breeze Modal] Breeze URL detected — neutralising redirect, opening modal' );

						// Open the modal first
						openModal( redirectUrl );

						// Return a 'pending' status response — Blocks treats this as
						// "payment not yet complete, stay on the page and wait".
						// This is the only reliable way to prevent Blocks from
						// navigating after processing the checkout response.
						var neutralised = JSON.parse( JSON.stringify( data ) );
						neutralised.payment_result.payment_status = 'pending';
						neutralised.payment_result.redirect_url   = '';
						if ( Array.isArray( neutralised.payment_result.payment_details ) ) {
							neutralised.payment_result.payment_details =
								neutralised.payment_result.payment_details.filter( function ( d ) {
									return d.key !== 'redirect' && d.key !== 'redirect_url';
								} );
						}

						return new Response( JSON.stringify( neutralised ), {
							status    : response.status,
							statusText: response.statusText,
							headers   : { 'Content-Type': 'application/json' },
						} );
					}

					// Not a Breeze redirect — reconstruct a normal response
					return new Response( JSON.stringify( data ), {
						status    : response.status,
						statusText: response.statusText,
						headers   : { 'Content-Type': 'application/json' },
					} );

				} ).catch( function ( e ) {
					console.log( '[Breeze Modal] Could not parse Store API response:', e );
					// Return original response untouched on parse error
					return response;
				} );
			} );
		};
	}

	/**
	 * Suppress navigation while the modal is open.
	 *
	 * WC Blocks sets window.location.href = url directly after processing
	 * the checkout response. This cannot be intercepted by patching
	 * location.assign() — direct href assignment bypasses it entirely.
	 *
	 * Instead we use Object.defineProperty to intercept the href setter
	 * on window.location, which catches ALL navigation methods including
	 * direct assignment.
	 */
	function suppressNextRedirectTo( targetUrl ) {
		var suppressing = true;

		// Get the real href descriptor from the Location prototype
		var locationProto   = Object.getPrototypeOf( window.location );
		var originalDescriptor = Object.getOwnPropertyDescriptor( locationProto, 'href' );

		// Also patch assign/replace as belt-and-suspenders
		var origAssign  = window.location.assign.bind( window.location );
		var origReplace = window.location.replace.bind( window.location );

		var origPushState    = history.pushState.bind( history );
		var origReplaceState = history.replaceState.bind( history );

		function shouldSuppress( url ) {
			return suppressing && url && isBreezePaymentUrl( url );
		}

		// Override href setter
		if ( originalDescriptor && originalDescriptor.set ) {
			Object.defineProperty( locationProto, 'href', {
				get: originalDescriptor.get,
				set: function ( url ) {
					if ( shouldSuppress( url ) ) {
						console.log( '[Breeze Modal] Suppressed location.href =', url );
						return;
					}
					originalDescriptor.set.call( this, url );
				},
				configurable: true,
			} );
		}

		window.location.assign = function ( url ) {
			if ( shouldSuppress( url ) ) {
				console.log( '[Breeze Modal] Suppressed location.assign:', url );
				return;
			}
			origAssign( url );
		};

		window.location.replace = function ( url ) {
			if ( shouldSuppress( url ) ) {
				console.log( '[Breeze Modal] Suppressed location.replace:', url );
				return;
			}
			origReplace( url );
		};

		history.pushState = function ( state, title, url ) {
			if ( url && shouldSuppress( url ) ) {
				console.log( '[Breeze Modal] Suppressed history.pushState:', url );
				return;
			}
			origPushState( state, title, url );
		};

		history.replaceState = function ( state, title, url ) {
			if ( url && shouldSuppress( url ) ) {
				console.log( '[Breeze Modal] Suppressed history.replaceState:', url );
				return;
			}
			origReplaceState( state, title, url );
		};

		var cleanup = function () {
			suppressing = false;

			// Restore href descriptor
			if ( originalDescriptor ) {
				Object.defineProperty( locationProto, 'href', originalDescriptor );
			}

			window.location.assign  = origAssign;
			window.location.replace = origReplace;
			history.pushState       = origPushState;
			history.replaceState    = origReplaceState;

			document.removeEventListener( 'breeze-modal-closed', cleanup );
			console.log( '[Breeze Modal] Navigation suppression removed' );
		};

		document.addEventListener( 'breeze-modal-closed', cleanup );
		setTimeout( cleanup, 120000 );
	}

	function extractRedirectUrl( data ) {
		if ( ! data || ! data.payment_result ) {
			return null;
		}

		var pr = data.payment_result;

		// Primary: top-level redirect_url on payment_result (confirmed in real response)
		if ( pr.redirect_url ) {
			return pr.redirect_url;
		}

		// Secondary: payment_details array with key === 'redirect'
		if ( Array.isArray( pr.payment_details ) ) {
			for ( var i = 0; i < pr.payment_details.length; i++ ) {
				var d = pr.payment_details[ i ];
				if ( d.key === 'redirect' || d.key === 'redirect_url' ) {
					return d.value || null;
				}
			}
		}

		return null;
	}

	function isBreezePaymentUrl( url ) {
		if ( ! url ) return false;
		// Breeze payment pages are hosted on pay.breeze.cash
		return url.indexOf( 'breeze.cash' ) !== -1 || url.indexOf( 'breeze.com' ) !== -1;
	}

	function urlsMatch( a, b ) {
		try {
			return new URL( a ).href === new URL( b ).href;
		} catch ( e ) {
			return a === b;
		}
	}

	/* ─────────────────────────────────────────────
	   Modal: build DOM (once)
	───────────────────────────────────────────── */
	function buildModal() {
		if ( document.getElementById( MODAL_ID ) ) return;

		var storeName = ( window.breezeModalData && window.breezeModalData.storeName ) || 'Checkout';

		overlayEl = document.createElement( 'div' );
		overlayEl.id = MODAL_ID;
		overlayEl.setAttribute( 'role', 'dialog' );
		overlayEl.setAttribute( 'aria-modal', 'true' );
		overlayEl.setAttribute( 'aria-label', 'Complete your payment' );
		overlayEl.innerHTML = [
			'<div class="breeze-modal-backdrop"></div>',
			'<div class="breeze-modal-container">',
				'<div class="breeze-modal-header">',
					'<div class="breeze-modal-header-left">',
						'<div class="breeze-modal-lock-icon">',
							'<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">',
								'<path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
								'<rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/>',
								'<circle cx="12" cy="16" r="1.5" fill="currentColor"/>',
							'</svg>',
						'</div>',
						'<span class="breeze-modal-title">Secure Checkout</span>',
						'<span class="breeze-modal-store">' + escapeHtml( storeName ) + '</span>',
					'</div>',
					'<button class="breeze-modal-close" aria-label="Close payment window" type="button">',
						'<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">',
							'<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
						'</svg>',
					'</button>',
				'</div>',
				'<div class="breeze-modal-body">',
					'<div class="breeze-modal-loading" id="breeze-iframe-loading">',
						'<div class="breeze-spinner"></div>',
						'<p>Loading secure payment page\u2026</p>',
					'</div>',
					'<iframe',
						' id="breeze-payment-iframe"',
						' class="breeze-modal-iframe"',
						' title="Breeze Secure Payment"',
						' allow="payment *; camera *; accelerometer *; gyroscope *; microphone *"',
						' sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox"',
					'></iframe>',
				'</div>',
				'<div class="breeze-modal-footer">',
					'<div class="breeze-modal-security-badges">',
						'<span class="breeze-badge">',
							'<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">',
								'<path d="M12 2L4 6v6c0 5.25 3.5 10.15 8 11.35C16.5 22.15 20 17.25 20 12V6L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
								'<path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
							'</svg>',
							'256-bit SSL',
						'</span>',
						'<span class="breeze-badge">Powered by Breeze</span>',
					'</div>',
					'<button class="breeze-modal-cancel" type="button">Cancel &amp; return to checkout</button>',
				'</div>',
			'</div>',
		].join( '' );

		document.body.appendChild( overlayEl );

		overlayEl.querySelector( '.breeze-modal-close' ).addEventListener( 'click', function() { closeModal('user-close-button'); } );
		overlayEl.querySelector( '.breeze-modal-cancel' ).addEventListener( 'click', function() { closeModal('user-cancel-button'); } );
		overlayEl.querySelector( '.breeze-modal-backdrop' ).addEventListener( 'click', function() { closeModal('backdrop-click'); } );

		document.addEventListener( 'keydown', function ( e ) {
			if ( e.key === 'Escape' && modalOpen ) closeModal('escape-key');
		} );

		iframeEl = overlayEl.querySelector( '#breeze-payment-iframe' );

		iframeEl.addEventListener( 'load', function () {
			// Verify the iframe actually loaded something useful
			// (a failed load still fires 'load' with about:blank)
			var src = iframeEl.src;
			if ( ! src || src === 'about:blank' ) return;
			console.log( '[Breeze Modal] iframe loaded:', src );
			var loading = overlayEl.querySelector( '#breeze-iframe-loading' );
			if ( loading ) loading.style.display = 'none';
			iframeEl.style.opacity = '1';
		} );

		iframeEl.addEventListener( 'error', function ( e ) {
			console.error( '[Breeze Modal] iframe failed to load:', e );
		} );

		// postMessage listener for Breeze iframe events + Apple Pay config request
		window.addEventListener( 'message', function ( event ) {
			// Apple Pay cross-domain config — Breeze requests this when the iframe loads.
			// Must respond regardless of whether modal is open (fires during iframe init).
			if ( event.data && event.data.type === 'request-global-config' && event.source ) {
				var domain = window.breezeModalData && window.breezeModalData.siteDomain;
				var config = {
					applePayEnabled: !! domain,
					crossDomainName: domain || '',
				};

				// Optionally pass theme if configured
				var theme = window.breezeModalData && window.breezeModalData.theme;
				if ( theme ) {
					config.theme = theme;
				}

				event.source.postMessage(
					{ type: 'request-global-config', config: config },
					'*'
				);
				console.log( '[Breeze Modal] Responded to request-global-config, applePayEnabled:', config.applePayEnabled );
				return;
			}

			// Breeze payment tracking events
			if ( ! modalOpen ) return;
			if ( ! event.data || event.data.type !== 'on-payment-event' ) return;
			var eventName = event.data.data && event.data.data.eventName;
			if ( eventName ) handleBreezeEvent( eventName );
		} );

		injectStyles();
	}

	/* ─────────────────────────────────────────────
	   Modal: open
	───────────────────────────────────────────── */
	function openModal( paymentUrl ) {
		buildModal();

		paymentConfirmed = false;

		var loading = overlayEl.querySelector( '#breeze-iframe-loading' );
		if ( loading ) loading.style.display = 'flex';
		iframeEl.style.opacity = '0';

		// Remove any previous confirmed overlay
		var prev = overlayEl.querySelector( '.breeze-payment-confirmed' );
		if ( prev ) prev.parentNode.removeChild( prev );

		// Re-enable close buttons in case they were locked by a previous attempt
		var closeBtn  = overlayEl.querySelector( '.breeze-modal-close' );
		var cancelBtn = overlayEl.querySelector( '.breeze-modal-cancel' );
		if ( closeBtn )  closeBtn.disabled  = false;
		if ( cancelBtn ) cancelBtn.disabled = false;

		// Append cross_domain_name param for Apple Pay cross-domain support.
		// Breeze reads this on load and enables Apple Pay for the certified domain.
		var domain = window.breezeModalData && window.breezeModalData.siteDomain;
		if ( domain ) {
			var separator = paymentUrl.indexOf( '?' ) !== -1 ? '&' : '?';
			iframeEl.src = paymentUrl + separator + 'cross_domain_name=' + encodeURIComponent( domain );
		} else {
			iframeEl.src = paymentUrl;
		}

		overlayEl.classList.add( 'is-open' );
		document.body.classList.add( 'breeze-modal-active' );
		modalOpen = true;

		trapFocus( overlayEl );
		startReturnUrlPolling();
	}

	/* ─────────────────────────────────────────────
	   Modal: close
	───────────────────────────────────────────── */
	function closeModal( reason ) {
		if ( ! modalOpen ) return;
		console.log( '[Breeze Modal] closeModal called, reason:', reason || 'unknown' );
		stopPolling();
		overlayEl.classList.remove( 'is-open' );
		document.body.classList.remove( 'breeze-modal-active' );
		modalOpen = false;
		document.dispatchEvent( new Event( 'breeze-modal-closed' ) );

		// If closed by the user (not by a completion redirect), reload checkout.
		// The pending response we sent to Blocks has permanently locked the Place
		// Order button — a reload is the only way to reset it.
		var isUserClose = (
			reason === 'user-close-button' ||
			reason === 'user-cancel-button' ||
			reason === 'backdrop-click'     ||
			reason === 'escape-key'
		);

		if ( isUserClose ) {
			var checkoutUrl = ( window.breezeModalData && window.breezeModalData.checkoutUrl )
				? window.breezeModalData.checkoutUrl
				: window.location.pathname;
			console.log( '[Breeze Modal] User closed modal — clearing Blocks state and reloading checkout' );
			clearBlocksClientState();
			// Small delay so the modal close animation plays before reload
			setTimeout( function () {
				window.location.href = checkoutUrl + '?breeze_payment=cancelled';
			}, 350 );
			return;
		}

		setTimeout( function () {
			if ( iframeEl ) iframeEl.src = 'about:blank';
		}, 400 );
	}

	/* ─────────────────────────────────────────────
	   Breeze postMessage events
	───────────────────────────────────────────── */
	function handleBreezeEvent( eventName ) {
		if ( SUCCESS_EVENTS.indexOf( eventName ) !== -1 && ! paymentConfirmed ) {
			paymentConfirmed = true;
			// Hide the iframe immediately so the customer never sees the
			// iframe redirect — show the confirmed overlay instead.
			if ( iframeEl ) {
				iframeEl.style.opacity = '0';
				iframeEl.style.pointerEvents = 'none';
			}
			showModalSuccessState();
			return;
		}
		if ( eventName === 'payin_action_3ds_requested' ) {
			expandModalFor3DS( true );
		} else if ( eventName === 'payin_action_3ds_cancelled' ) {
			expandModalFor3DS( false );
		} else if ( eventName === 'payin_action_card_input_validation_error' ) {
			shakeModal();
		}
	}

	function showModalSuccessState() {
		var body = overlayEl && overlayEl.querySelector( '.breeze-modal-body' );
		if ( ! body ) return;

		var confirm = document.createElement( 'div' );
		confirm.className = 'breeze-payment-confirmed';
		confirm.innerHTML = [
			'<div class="breeze-confirm-icon">',
				'<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">',
					'<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>',
					'<path d="M8 12l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
				'</svg>',
			'</div>',
			'<p>Payment confirmed!</p>',
			'<p class="breeze-confirm-sub">Completing your order\u2026</p>',
		].join( '' );
		body.appendChild( confirm );
		setTimeout( function () { confirm.classList.add( 'is-visible' ); }, 16 );

		var closeBtn  = overlayEl.querySelector( '.breeze-modal-close' );
		var cancelBtn = overlayEl.querySelector( '.breeze-modal-cancel' );
		if ( closeBtn )  closeBtn.disabled  = true;
		if ( cancelBtn ) cancelBtn.disabled = true;
	}

	function expandModalFor3DS( expand ) {
		var container = overlayEl && overlayEl.querySelector( '.breeze-modal-container' );
		if ( ! container ) return;
		if ( expand ) {
			container.classList.add( 'is-3ds' );
		} else {
			container.classList.remove( 'is-3ds' );
		}
	}

	function shakeModal() {
		var container = overlayEl && overlayEl.querySelector( '.breeze-modal-container' );
		if ( ! container ) return;
		container.classList.remove( 'is-shaking' );
		void container.offsetWidth;
		container.classList.add( 'is-shaking' );
		container.addEventListener( 'animationend', function onEnd() {
			container.classList.remove( 'is-shaking' );
			container.removeEventListener( 'animationend', onEnd );
		} );
	}

	/* ─────────────────────────────────────────────
	   URL polling (fallback — mainly for crypto)
	───────────────────────────────────────────── */
	function startReturnUrlPolling() {
		stopPolling();
		var breezeOriginSeen = false;

		pollTimer = setInterval( function () {
			try {
				// This throws while the iframe is on pay.breeze.cash (cross-origin).
				// It becomes readable only once the iframe navigates to our domain.
				var loc = iframeEl.contentWindow.location.href;

				if ( ! loc || loc === 'about:blank' ) return;

				console.log( '[Breeze Modal] iframe navigated to same-origin URL:', loc );
				stopPolling();

					var url = new URL( loc );

					// Case 1: Breeze's explicit wc-api return URL — has explicit status param
					if ( url.searchParams.get( 'wc-api' ) === 'breeze_return' ) {
						var status = url.searchParams.get( 'status' );
						console.log( '[Breeze Modal] Breeze return URL, status:', status );
						handleReturnUrl( loc, status );
						return;
					}

					// Case 2: WC order-received page — definitive success
					if ( loc.indexOf( 'order-received' ) !== -1 ) {
						console.log( '[Breeze Modal] Order received page — success' );
						handleReturnUrl( loc, 'success' );
						return;
					}

					// Case 3: Cart page — Breeze sends here on failure/cancellation
					if ( loc.indexOf( '/cart' ) !== -1 ) {
						console.log( '[Breeze Modal] Cart page — payment failed or cancelled' );
						handleReturnUrl( loc, 'fail' );
						return;
					}

					// Case 4: Back to checkout without order-received — failure/cancellation
					if ( loc.indexOf( '/checkout' ) !== -1 ) {
						console.log( '[Breeze Modal] Checkout page — payment failed or cancelled' );
						handleReturnUrl( loc, 'fail' );
						return;
					}

					// Case 5: Unknown URL — safe default is failure
					console.log( '[Breeze Modal] Unknown same-origin URL — treating as failure:', loc );
					handleReturnUrl( loc, 'fail' );

			} catch ( e ) {
				// Still cross-origin (pay.breeze.cash) — keep polling
				breezeOriginSeen = true;
			}
		}, POLL_MS );
	}

	function stopPolling() {
		if ( pollTimer ) {
			clearInterval( pollTimer );
			pollTimer = null;
		}
	}

	function handleReturnUrl( returnUrl, status ) {
		// Close modal first — restores all navigation patches
		closeModal( 'return-url-' + status );

		if ( status === 'success' ) {
			console.log( '[Breeze Modal] Payment success — redirecting to:', returnUrl );
			window.location.href = returnUrl;
		} else {
			var msg = status === 'fail' ? 'failed' : 'cancelled';
			console.log( '[Breeze Modal] Payment ' + msg + ' — clearing Blocks state and reloading checkout' );

			// WC Blocks stores draft order state in multiple places client-side.
			// We must clear all of them before reloading, otherwise Blocks rehydrates
			// with the stale pending order and gets stuck in a loading loop.
			clearBlocksClientState();

			var checkoutUrl = ( window.breezeModalData && window.breezeModalData.checkoutUrl )
				? window.breezeModalData.checkoutUrl
				: window.location.pathname;

			window.location.href = checkoutUrl + '?breeze_payment=' + msg;
		}
	}

	/**
	 * Clears all client-side state that WC Blocks uses to resume a pending checkout.
	 * Blocks stores draft order IDs in localStorage and sessionStorage under various
	 * keys — leaving these causes the checkout to reload into a stuck "loading" state.
	 */
	function clearBlocksClientState() {
		// The draft order is stored server-side (PHP session), not in localStorage.
		// PHP handles that on the ?breeze_payment redirect.
		// Here we only clear the Blocks React store state that lives in memory —
		// we do this by dispatching a reset to the WC Blocks store if available.
		try {
			if (
				window.wp &&
				window.wp.data &&
				window.wp.data.dispatch
			) {
				// Reset the checkout store so Blocks forgets the pending order
				var checkoutStore = window.wp.data.dispatch( 'wc/store/checkout' );
				if ( checkoutStore && checkoutStore.__internalSetIdle ) {
					checkoutStore.__internalSetIdle();
				}
				// Also invalidate the cart store so it refetches cleanly
				var cartStore = window.wp.data.dispatch( 'wc/store/cart' );
				if ( cartStore && cartStore.invalidateResolutionForStore ) {
					cartStore.invalidateResolutionForStore();
				}
			}
		} catch ( e ) {
			console.log( '[Breeze Modal] Blocks store reset failed:', e );
		}
	}

	/* ─────────────────────────────────────────────
	   Show error in Blocks checkout notice area
	───────────────────────────────────────────── */
	function showBlocksError( message ) {
		// WC Blocks renders notices inside .wc-block-components-notices
		var noticeArea = document.querySelector(
			'.wc-block-components-notices, .wp-block-woocommerce-checkout-fields-block'
		);

		var notice = document.createElement( 'div' );
		notice.className = 'wc-block-components-notice-banner is-error breeze-error-notice';
		notice.setAttribute( 'role', 'alert' );
		notice.innerHTML = '<p>' + escapeHtml( message ) + '</p>';

		if ( noticeArea ) {
			noticeArea.insertBefore( notice, noticeArea.firstChild );
			notice.scrollIntoView( { behavior: 'smooth', block: 'center' } );
		}

		setTimeout( function () {
			if ( notice.parentNode ) notice.parentNode.removeChild( notice );
		}, 8000 );
	}

	/* ─────────────────────────────────────────────
	   Utilities
	───────────────────────────────────────────── */
	function trapFocus( container ) {
		var focusable = container.querySelectorAll(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
		);
		if ( ! focusable.length ) return;
		var first = focusable[0];
		var last  = focusable[ focusable.length - 1 ];
		first.focus();
		container.addEventListener( 'keydown', function focusTrap( e ) {
			if ( e.key !== 'Tab' ) return;
			if ( e.shiftKey ) {
				if ( document.activeElement === first ) { e.preventDefault(); last.focus(); }
			} else {
				if ( document.activeElement === last )  { e.preventDefault(); first.focus(); }
			}
			if ( ! modalOpen ) container.removeEventListener( 'keydown', focusTrap );
		} );
	}

	function escapeHtml( str ) {
		var div = document.createElement( 'div' );
		div.appendChild( document.createTextNode( str ) );
		return div.innerHTML;
	}

	/* ─────────────────────────────────────────────
	   Styles
	───────────────────────────────────────────── */
	function injectStyles() {
		if ( document.getElementById( 'breeze-modal-styles' ) ) return;
		var css = [
			'#' + MODAL_ID + '{display:none;position:fixed;inset:0;z-index:999999;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
			'#' + MODAL_ID + '.is-open{display:flex;}',
			'.breeze-modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);animation:breeze-fade-in .25s ease forwards;}',
			'.breeze-modal-container{position:relative;z-index:1;display:flex;flex-direction:column;width:min(90vw,520px);max-height:92vh;background:#fff;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.22),0 4px 16px rgba(0,0,0,.12);overflow:hidden;animation:breeze-slide-up .3s cubic-bezier(.34,1.56,.64,1) forwards;}',
			'.breeze-modal-header{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #f0f0f0;background:#fafafa;flex-shrink:0;}',
			'.breeze-modal-header-left{display:flex;align-items:center;gap:10px;}',
			'.breeze-modal-lock-icon{width:32px;height:32px;background:#e8f5e9;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#2e7d32;flex-shrink:0;}',
			'.breeze-modal-lock-icon svg{width:16px;height:16px;}',
			'.breeze-modal-title{font-size:15px;font-weight:600;color:#1a1a1a;line-height:1;}',
			'.breeze-modal-store{font-size:12px;color:#888;line-height:1;padding-left:2px;}',
			'.breeze-modal-close{width:32px;height:32px;border:none;background:#f0f0f0;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#555;transition:background .15s,color .15s;flex-shrink:0;padding:0;}',
			'.breeze-modal-close:hover{background:#e0e0e0;color:#111;}',
			'.breeze-modal-close svg{width:16px;height:16px;}',
			'.breeze-modal-body{position:relative;flex:1;min-height:440px;overflow:hidden;}',
			'.breeze-modal-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#fff;z-index:2;}',
			'.breeze-modal-loading p{font-size:14px;color:#888;margin:0;}',
			'.breeze-spinner{width:36px;height:36px;border:3px solid #e8e8e8;border-top-color:#1a73e8;border-radius:50%;animation:breeze-spin .75s linear infinite;}',
			'.breeze-modal-iframe{width:100%;height:100%;border:none;display:block;opacity:0;transition:opacity .3s ease;min-height:440px;}',
			'.breeze-modal-footer{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-top:1px solid #f0f0f0;background:#fafafa;flex-shrink:0;gap:12px;}',
			'.breeze-modal-security-badges{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
			'.breeze-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#666;font-weight:500;}',
			'.breeze-modal-cancel{border:none;background:none;font-size:12px;color:#999;cursor:pointer;padding:4px 0;text-decoration:underline;white-space:nowrap;transition:color .15s;}',
			'.breeze-modal-cancel:hover{color:#555;}',
			'body.breeze-modal-active{overflow:hidden;}',
			'.breeze-modal-container.is-3ds{width:min(95vw,600px);max-height:98vh;}',
			'.breeze-modal-container.is-3ds .breeze-modal-iframe{min-height:600px;}',
			'@keyframes breeze-shake{0%,100%{transform:translateX(0)}15%{transform:translateX(-6px)}30%{transform:translateX(5px)}45%{transform:translateX(-4px)}60%{transform:translateX(3px)}75%{transform:translateX(-2px)}}',
			'.breeze-modal-container.is-shaking{animation:breeze-shake .45s ease;}',
			'.breeze-payment-confirmed{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(255,255,255,.96);z-index:10;opacity:0;transition:opacity .3s ease;}',
			'.breeze-payment-confirmed.is-visible{opacity:1;}',
			'.breeze-confirm-icon{width:56px;height:56px;background:#e8f5e9;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#2e7d32;animation:breeze-pop .4s cubic-bezier(.34,1.56,.64,1) forwards;}',
			'.breeze-confirm-icon svg{width:28px;height:28px;}',
			'.breeze-payment-confirmed p{margin:0;font-size:16px;font-weight:600;color:#1a1a1a;}',
			'.breeze-confirm-sub{font-size:13px!important;font-weight:400!important;color:#888!important;}',
			'.breeze-modal-close:disabled,.breeze-modal-cancel:disabled{opacity:.3;cursor:not-allowed;pointer-events:none;}',
			'@keyframes breeze-fade-in{from{opacity:0}to{opacity:1}}',
			'@keyframes breeze-slide-up{from{opacity:0;transform:translateY(24px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}',
			'@keyframes breeze-spin{to{transform:rotate(360deg)}}',
			'@keyframes breeze-pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}',
			'@media(max-width:540px){.breeze-modal-container{width:100%;max-height:100%;height:100%;border-radius:0;}#' + MODAL_ID + '.is-open{align-items:flex-end;}.breeze-modal-footer{flex-direction:column;align-items:flex-start;gap:8px;}}',
		].join( '\n' );

		var style = document.createElement( 'style' );
		style.id = 'breeze-modal-styles';
		style.textContent = css;
		document.head.appendChild( style );
	}

	/* ─────────────────────────────────────────────
	   Boot
	   We do NOT re-register the payment method here —
	   Breeze's own blocks script already handles that.
	   Our only job is to intercept the redirect URL
	   that process_payment() returns and open the modal.
	───────────────────────────────────────────── */
	document.addEventListener( 'DOMContentLoaded', function () {
		console.log( '[Breeze Modal] Blocks intercept initialising...' );
		interceptBlocksRedirect();
		console.log( '[Breeze Modal] fetch() patched, waiting for checkout submission.' );

		// Inject any pending payment notice AFTER Blocks has hydrated.
		// We wait for the woocommerce/checkout block to finish rendering
		// before inserting — injecting into the server HTML causes hydration
		// mismatches that blank out the form.
		var notice = window.breezeModalData && window.breezeModalData.pendingNotice;
		if ( notice ) {
			injectNoticeAfterHydration( notice );
		}
	} );

	function injectNoticeAfterHydration( message ) {
		// WC Blocks renders a notices container early in hydration.
		// We watch for it with a MutationObserver — much faster than polling
		// for the Place Order button which appears later.
		var inserted = false;

		function tryInsert() {
			if ( inserted ) return;

			// WC Blocks notices slot — the canonical place for checkout notices
			var noticeContainer = document.querySelector(
				'.wc-block-components-notices, ' +
				'.wc-block-checkout__notices, ' +
				'.wp-block-woocommerce-checkout-fields-block'
			);

			if ( ! noticeContainer ) return;
			inserted = true;

			var div = document.createElement( 'div' );
			div.className = 'wc-block-components-notice-banner is-error bmc-payment-notice';
			div.setAttribute( 'role', 'alert' );
			div.innerHTML = '<p>' + escapeHtml( message ) + '</p>';

			// Insert at top of the notices container
			noticeContainer.insertBefore( div, noticeContainer.firstChild );
			console.log( '[Breeze Modal] Payment notice injected into notices container' );
		}

		// Try immediately in case Blocks already rendered
		tryInsert();
		if ( inserted ) return;

		// Otherwise watch the DOM for the notices container to appear
		var observer = new MutationObserver( function () {
			tryInsert();
			if ( inserted ) observer.disconnect();
		} );

		observer.observe( document.body, { childList: true, subtree: true } );

		// Safety: disconnect after 5s regardless
		setTimeout( function () {
			observer.disconnect();
			// Last attempt using the checkout block itself as fallback target
			if ( inserted ) return;
			var fallback = document.querySelector( '.wp-block-woocommerce-checkout' );
			if ( ! fallback ) return;
			var div = document.createElement( 'div' );
			div.className = 'wc-block-components-notice-banner is-error bmc-payment-notice';
			div.setAttribute( 'role', 'alert' );
			div.innerHTML = '<p>' + escapeHtml( message ) + '</p>';
			fallback.insertBefore( div, fallback.firstChild );
		}, 5000 );
	}

} )();
