/**
 * Breeze Modal Checkout SDK
 *
 * Intercepts the WooCommerce "Place Order" flow for the Breeze gateway,
 * creates the payment page via WP AJAX (server-side), then presents the
 * Breeze-hosted payment URL inside a polished modal/lightbox instead of
 * doing a full-page redirect.
 *
 * Requirements on the PHP side:
 *  - wp_localize_script() must expose window.breezeModalData with:
 *      ajaxUrl       : admin-ajax URL
 *      nonce         : wp_create_nonce('breeze_modal_nonce')
 *      returnUrl     : success return URL (with order_id placeholder)
 *      currency      : store currency code
 *      storeName     : get_bloginfo('name')
 *      iframeAllowed : bool — whether Breeze allows iframe embedding
 *
 * Flow:
 *  1. Customer selects Breeze, fills billing details, clicks "Place Order"
 *  2. WooCommerce validates the form and would normally submit → redirect
 *  3. We intercept checkout_place_order_breeze_payment_gateway
 *  4. POST to admin-ajax: breeze_create_modal_payment
 *  5. PHP creates the WC order + calls Breeze API → returns { paymentUrl, orderId }
 *  6. Modal opens with an <iframe> pointing at the Breeze payment URL
 *  7. Breeze redirects to successReturnUrl / failReturnUrl on completion
 *  8. We detect the return URL in the iframe, close modal, redirect top-level
 */

( function ( $ ) {
	'use strict';

	/* ─────────────────────────────────────────────
	   Constants
	───────────────────────────────────────────── */
	const GATEWAY_ID   = 'breeze_payment_gateway';
	const MODAL_ID     = 'breeze-modal-overlay';
	const POLL_MS      = 800;   // iframe URL polling interval (fallback)
	const TIMEOUT_MS   = 30000; // AJAX timeout

	// Breeze postMessage success events — covers card, Apple Pay, Google Pay.
	// Crypto has no postMessage success event so the URL poll is the fallback for that.
	const SUCCESS_EVENTS = new Set( [
		'payin_action_card_payment_success',
		'payin_action_apple_pay_payment_success',
		'payin_action_google_pay_payment_success',
	] );

	/* ─────────────────────────────────────────────
	   State
	───────────────────────────────────────────── */
	let modalOpen         = false;
	let pollTimer         = null;
	let iframeEl          = null;
	let overlayEl         = null;
	let currentOrderId    = null;
	let paymentConfirmed  = false; // true once a success postMessage fires

	/* ─────────────────────────────────────────────
	   Init — runs after DOM ready
	───────────────────────────────────────────── */
	function init() {
		if ( typeof window.breezeModalData === 'undefined' ) {
			console.warn( '[Breeze Modal] breezeModalData not found. PHP localisation missing?' );
			return;
		}

		injectStyles();
		buildModal();
		bindCheckoutHook();
		bindPostMessage();
	}

	/* ─────────────────────────────────────────────
	   Intercept WooCommerce checkout submission
	───────────────────────────────────────────── */
	function bindCheckoutHook() {
		// WooCommerce fires this filter before submitting for the selected gateway.
		// Returning false cancels the default submission and hands control to us.
		$( document.body ).on(
			'checkout_place_order_' + GATEWAY_ID,
			function () {
				handlePlaceOrder();
				return false; // prevent default WC form submit
			}
		);

		// Also handle the case where the form is submitted directly
		// (e.g. keyboard Enter) while Breeze is selected.
		$( document ).on( 'submit', 'form.checkout', function ( e ) {
			const selected = $( '#payment_method_' + GATEWAY_ID );
			if ( selected.length && selected.is( ':checked' ) ) {
				e.preventDefault();
				e.stopImmediatePropagation();
				handlePlaceOrder();
			}
		} );
	}

	/* ─────────────────────────────────────────────
	   Core: create order + open modal
	───────────────────────────────────────────── */
	function handlePlaceOrder() {
		if ( modalOpen ) return;

		// Run WooCommerce's own front-end validation first.
		// wc_checkout_form.submit() would normally do this; we call the validator directly.
		if ( ! validateCheckoutForm() ) return;

		showLoadingState( true );

		const formData = $( 'form.checkout' ).serialize();

		$.ajax( {
			url     : window.breezeModalData.ajaxUrl,
			type    : 'POST',
			timeout : TIMEOUT_MS,
			data    : {
				action : 'breeze_create_modal_payment',
				nonce  : window.breezeModalData.nonce,
				form   : formData,
			},
			success : function ( response ) {
				showLoadingState( false );

				if ( ! response.success ) {
					showError( response.data && response.data.message
						? response.data.message
						: 'Payment setup failed. Please try again.' );
					return;
				}

				const { paymentUrl, orderId } = response.data;

				if ( ! paymentUrl ) {
					showError( 'No payment URL returned. Please try again.' );
					return;
				}

				openModal( paymentUrl, orderId );
			},
			error : function ( xhr, status ) {
				showLoadingState( false );
				if ( status === 'timeout' ) {
					showError( 'Request timed out. Please check your connection and try again.' );
				} else {
					showError( 'An unexpected error occurred. Please try again.' );
				}
			},
		} );
	}

	/* ─────────────────────────────────────────────
	   Checkout form validation
	───────────────────────────────────────────── */
	function validateCheckoutForm() {
		// WooCommerce exposes wc_checkout_form — call its validate method if available.
		if ( typeof wc_checkout_form !== 'undefined' && wc_checkout_form.validate ) {
			return wc_checkout_form.validate();
		}

		// Fallback: check required fields manually.
		let valid = true;
		$( 'form.checkout .validate-required' ).each( function () {
			const field = $( this ).find( 'input, select, textarea' ).first();
			if ( field.val() === '' || field.val() === null ) {
				$( this ).addClass( 'woocommerce-invalid woocommerce-invalid-required-field' );
				valid = false;
			}
		} );

		if ( ! valid ) {
			$( 'html, body' ).animate(
				{ scrollTop: $( '.woocommerce-invalid' ).first().offset().top - 100 },
				400
			);
		}

		return valid;
	}

	/* ─────────────────────────────────────────────
	   Modal: build DOM structure (once)
	───────────────────────────────────────────── */
	function buildModal() {
		if ( document.getElementById( MODAL_ID ) ) return;

		const storeName = window.breezeModalData.storeName || 'Checkout';

		overlayEl = document.createElement( 'div' );
		overlayEl.id = MODAL_ID;
		overlayEl.setAttribute( 'role', 'dialog' );
		overlayEl.setAttribute( 'aria-modal', 'true' );
		overlayEl.setAttribute( 'aria-label', 'Complete your payment' );
		overlayEl.innerHTML = `
			<div class="breeze-modal-backdrop"></div>
			<div class="breeze-modal-container">
				<div class="breeze-modal-header">
					<div class="breeze-modal-header-left">
						<div class="breeze-modal-lock-icon">
							<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
								<path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
								<rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/>
								<circle cx="12" cy="16" r="1.5" fill="currentColor"/>
							</svg>
						</div>
						<span class="breeze-modal-title">Secure Checkout</span>
						<span class="breeze-modal-store">${ escapeHtml( storeName ) }</span>
					</div>
					<button class="breeze-modal-close" aria-label="Close payment window" type="button">
						<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
						</svg>
					</button>
				</div>

				<div class="breeze-modal-body">
					<div class="breeze-modal-loading" id="breeze-iframe-loading">
						<div class="breeze-spinner"></div>
						<p>Loading secure payment page…</p>
					</div>
					<iframe
						id="breeze-payment-iframe"
						class="breeze-modal-iframe"
						title="Breeze Secure Payment"
						allow="payment"
						sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-top-navigation-by-user-activation"
					></iframe>
				</div>

				<div class="breeze-modal-footer">
					<div class="breeze-modal-security-badges">
						<span class="breeze-badge">
							<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
								<path d="M12 2L4 6v6c0 5.25 3.5 10.15 8 11.35C16.5 22.15 20 17.25 20 12V6L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
								<path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
							256-bit SSL
						</span>
						<span class="breeze-badge">
							<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
								<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
								<path d="M12 8v4l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
							</svg>
							Powered by Breeze
						</span>
					</div>
					<button class="breeze-modal-cancel" type="button">Cancel &amp; return to checkout</button>
				</div>
			</div>
		`;

		document.body.appendChild( overlayEl );

		// Event bindings
		overlayEl.querySelector( '.breeze-modal-close' )
			.addEventListener( 'click', closeModal );
		overlayEl.querySelector( '.breeze-modal-cancel' )
			.addEventListener( 'click', closeModal );
		overlayEl.querySelector( '.breeze-modal-backdrop' )
			.addEventListener( 'click', closeModal );

		// Keyboard: Escape closes
		document.addEventListener( 'keydown', function ( e ) {
			if ( e.key === 'Escape' && modalOpen ) closeModal();
		} );

		iframeEl = overlayEl.querySelector( '#breeze-payment-iframe' );

		// Hide loading spinner once iframe has loaded
		iframeEl.addEventListener( 'load', function () {
			const loading = overlayEl.querySelector( '#breeze-iframe-loading' );
			if ( loading ) loading.style.display = 'none';
			iframeEl.style.opacity = '1';
		} );
	}

	/* ─────────────────────────────────────────────
	   Modal: open with payment URL
	───────────────────────────────────────────── */
	function openModal( paymentUrl, orderId ) {
		if ( ! overlayEl || ! iframeEl ) buildModal();

		// Reset state for this payment attempt
		currentOrderId   = orderId;
		paymentConfirmed = false;

		// Reset iframe state
		const loading = overlayEl.querySelector( '#breeze-iframe-loading' );
		if ( loading ) loading.style.display = 'flex';
		iframeEl.style.opacity = '0';
		iframeEl.src = paymentUrl;

		overlayEl.classList.add( 'is-open' );
		document.body.classList.add( 'breeze-modal-active' );
		modalOpen = true;

		// Trap focus inside modal
		trapFocus( overlayEl );

		// Start URL polling as a fallback (catches crypto + any missed postMessage events).
		startReturnUrlPolling( orderId );
	}

	/* ─────────────────────────────────────────────
	   Modal: close
	───────────────────────────────────────────── */
	function closeModal() {
		if ( ! modalOpen ) return;

		stopPolling();

		overlayEl.classList.remove( 'is-open' );
		document.body.classList.remove( 'breeze-modal-active' );
		modalOpen = false;

		// Clear iframe src so we don't leave a live Breeze session dangling
		setTimeout( function () {
			if ( iframeEl ) iframeEl.src = 'about:blank';
		}, 400 );
	}

	/* ─────────────────────────────────────────────
	   Breeze postMessage listener
	   Handles analytics events from the Breeze iframe.
	   Note: these are tracking events, not flow-control events.
	   The iframe still redirects to our return URL after payment —
	   postMessage just lets us react earlier and improve UX.
	───────────────────────────────────────────── */
	function bindPostMessage() {
		window.addEventListener( 'message', function ( event ) {
			// Only act on Breeze payment events while our modal is open.
			if ( ! modalOpen ) return;
			if ( ! event.data || event.data.type !== 'on-payment-event' ) return;

			const eventName = event.data.data && event.data.data.eventName;
			if ( ! eventName ) return;

			handleBreezeEvent( eventName );
		} );
	}

	function handleBreezeEvent( eventName ) {
		// ── Payment succeeded (card / Apple Pay / Google Pay) ──────────
		// Crypto has no postMessage success event — the URL poll handles it.
		if ( SUCCESS_EVENTS.has( eventName ) && ! paymentConfirmed ) {
			paymentConfirmed = true;
			showModalSuccessState();
			// Keep polling so we get the token-verified return URL for the redirect.
			return;
		}

		// ── 3DS challenge requested — needs more vertical space ────────
		if ( eventName === 'payin_action_3ds_requested' ) {
			expandModalFor3DS( true );
			return;
		}

		// ── 3DS cancelled — shrink back ────────────────────────────────
		if ( eventName === 'payin_action_3ds_cancelled' ) {
			expandModalFor3DS( false );
			return;
		}

		// ── Validation error — subtle shake on the modal ───────────────
		if ( eventName === 'payin_action_card_input_validation_error' ) {
			shakeModal();
			return;
		}
	}

	function showModalSuccessState() {
		const body = overlayEl && overlayEl.querySelector( '.breeze-modal-body' );
		if ( ! body ) return;

		// Inject a brief "Payment confirmed!" overlay — Breeze will redirect
		// the iframe to our return URL momentarily.
		let confirm = body.querySelector( '.breeze-payment-confirmed' );
		if ( ! confirm ) {
			confirm = document.createElement( 'div' );
			confirm.className = 'breeze-payment-confirmed';
			confirm.innerHTML = `
				<div class="breeze-confirm-icon">
					<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
						<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
						<path d="M8 12l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				</div>
				<p>Payment confirmed!</p>
				<p class="breeze-confirm-sub">Completing your order…</p>
			`;
			body.appendChild( confirm );
		}

		// Fade in
		requestAnimationFrame( () => confirm.classList.add( 'is-visible' ) );

		// Lock the close button — don't let the customer accidentally dismiss
		// the modal while we wait for the return URL redirect.
		const closeBtn = overlayEl.querySelector( '.breeze-modal-close' );
		const cancelBtn = overlayEl.querySelector( '.breeze-modal-cancel' );
		if ( closeBtn ) closeBtn.disabled = true;
		if ( cancelBtn ) cancelBtn.disabled = true;
	}

	function expandModalFor3DS( expand ) {
		const container = overlayEl && overlayEl.querySelector( '.breeze-modal-container' );
		if ( ! container ) return;
		container.classList.toggle( 'is-3ds', expand );
	}

	function shakeModal() {
		const container = overlayEl && overlayEl.querySelector( '.breeze-modal-container' );
		if ( ! container ) return;
		container.classList.remove( 'is-shaking' );
		// Force reflow to restart animation
		void container.offsetWidth;
		container.classList.add( 'is-shaking' );
		container.addEventListener( 'animationend', function onEnd() {
			container.classList.remove( 'is-shaking' );
			container.removeEventListener( 'animationend', onEnd );
		} );
	}

	/* ─────────────────────────────────────────────
	   Poll iframe location to detect return URL
	   Fallback for crypto payments and any edge cases
	   where postMessage success doesn't fire.
	───────────────────────────────────────────── */
	function startReturnUrlPolling( orderId ) {
		stopPolling();

		pollTimer = setInterval( function () {
			try {
				// Same-origin check: readable only after Breeze redirects back to our domain.
				const loc = iframeEl.contentWindow.location.href;

				if ( loc && loc !== 'about:blank' ) {
					const url = new URL( loc );

					if ( url.searchParams.get( 'wc-api' ) === 'breeze_return' ) {
						stopPolling();
						const status = url.searchParams.get( 'status' );
						handleReturnUrl( loc, status, orderId );
					}
				}
			} catch ( e ) {
				// Cross-origin — Breeze page still showing, keep polling.
			}
		}, POLL_MS );
	}

	function stopPolling() {
		if ( pollTimer ) {
			clearInterval( pollTimer );
			pollTimer = null;
		}
	}

	/* ─────────────────────────────────────────────
	   Handle Breeze return redirect
	───────────────────────────────────────────── */
	function handleReturnUrl( returnUrl, status, orderId ) {
		closeModal();

		if ( status === 'success' ) {
			// Redirect top-level window to the WC thank-you page.
			// The return URL already contains order_id and token,
			// so WC will set the order to on-hold and show the receipt.
			window.location.href = returnUrl;
		} else {
			// Payment failed or cancelled — stay on checkout, show notice.
			showError(
				'Payment was not completed. Please try again or choose a different payment method.',
				true
			);
		}
	}

	/* ─────────────────────────────────────────────
	   UI helpers
	───────────────────────────────────────────── */
	function showLoadingState( active ) {
		const btn = $( '#place_order' );
		if ( active ) {
			btn.prop( 'disabled', true ).addClass( 'breeze-btn-loading' );
			$( 'form.checkout' ).addClass( 'processing' );
		} else {
			btn.prop( 'disabled', false ).removeClass( 'breeze-btn-loading' );
			$( 'form.checkout' ).removeClass( 'processing' );
		}
	}

	function showError( message, scroll ) {
		// Use WooCommerce's own notice mechanism if available.
		if ( typeof wc_checkout_form !== 'undefined' && wc_checkout_form.submit_error ) {
			wc_checkout_form.submit_error( '<div class="woocommerce-error">' + escapeHtml( message ) + '</div>' );
			return;
		}

		// Fallback: inject above the checkout form.
		$( '.woocommerce-NoticeGroup-checkout, .breeze-error-notice' ).remove();
		const notice = $( '<div class="woocommerce-NoticeGroup woocommerce-NoticeGroup-checkout breeze-error-notice">'
			+ '<ul class="woocommerce-error" role="alert"><li>' + escapeHtml( message ) + '</li></ul></div>' );
		$( 'form.checkout' ).prepend( notice );

		if ( scroll !== false ) {
			$( 'html, body' ).animate( { scrollTop: notice.offset().top - 100 }, 400 );
		}
	}

	function trapFocus( container ) {
		const focusable = container.querySelectorAll(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
		);
		if ( ! focusable.length ) return;

		const first = focusable[ 0 ];
		const last  = focusable[ focusable.length - 1 ];

		first.focus();

		container.addEventListener( 'keydown', function focusTrap( e ) {
			if ( e.key !== 'Tab' ) return;
			if ( e.shiftKey ) {
				if ( document.activeElement === first ) { e.preventDefault(); last.focus(); }
			} else {
				if ( document.activeElement === last ) { e.preventDefault(); first.focus(); }
			}
			if ( ! modalOpen ) container.removeEventListener( 'keydown', focusTrap );
		} );
	}

	function escapeHtml( str ) {
		const div = document.createElement( 'div' );
		div.appendChild( document.createTextNode( str ) );
		return div.innerHTML;
	}

	/* ─────────────────────────────────────────────
	   Styles — injected into <head>
	───────────────────────────────────────────── */
	function injectStyles() {
		if ( document.getElementById( 'breeze-modal-styles' ) ) return;

		const css = `
/* ── Breeze Modal Overlay ───────────────────────────────────────── */
#${ MODAL_ID } {
	display: none;
	position: fixed;
	inset: 0;
	z-index: 999999;
	align-items: center;
	justify-content: center;
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
#${ MODAL_ID }.is-open {
	display: flex;
}

.breeze-modal-backdrop {
	position: absolute;
	inset: 0;
	background: rgba(0, 0, 0, 0.55);
	backdrop-filter: blur(4px);
	-webkit-backdrop-filter: blur(4px);
	animation: breeze-fade-in 0.25s ease forwards;
}

/* ── Container ──────────────────────────────────────────────────── */
.breeze-modal-container {
	position: relative;
	z-index: 1;
	display: flex;
	flex-direction: column;
	width: min(90vw, 520px);
	max-height: 92vh;
	background: #ffffff;
	border-radius: 16px;
	box-shadow: 0 24px 64px rgba(0,0,0,0.22), 0 4px 16px rgba(0,0,0,0.12);
	overflow: hidden;
	animation: breeze-slide-up 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

/* ── Header ─────────────────────────────────────────────────────── */
.breeze-modal-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 18px 20px;
	border-bottom: 1px solid #f0f0f0;
	background: #fafafa;
	flex-shrink: 0;
}
.breeze-modal-header-left {
	display: flex;
	align-items: center;
	gap: 10px;
}
.breeze-modal-lock-icon {
	width: 32px;
	height: 32px;
	background: #e8f5e9;
	border-radius: 8px;
	display: flex;
	align-items: center;
	justify-content: center;
	color: #2e7d32;
	flex-shrink: 0;
}
.breeze-modal-lock-icon svg {
	width: 16px;
	height: 16px;
}
.breeze-modal-title {
	font-size: 15px;
	font-weight: 600;
	color: #1a1a1a;
	line-height: 1;
}
.breeze-modal-store {
	font-size: 12px;
	color: #888;
	line-height: 1;
	padding-left: 2px;
}
.breeze-modal-close {
	width: 32px;
	height: 32px;
	border: none;
	background: #f0f0f0;
	border-radius: 8px;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	color: #555;
	transition: background 0.15s, color 0.15s;
	flex-shrink: 0;
	padding: 0;
}
.breeze-modal-close:hover {
	background: #e0e0e0;
	color: #111;
}
.breeze-modal-close svg {
	width: 16px;
	height: 16px;
}

/* ── Body / iframe ──────────────────────────────────────────────── */
.breeze-modal-body {
	position: relative;
	flex: 1;
	min-height: 440px;
	overflow: hidden;
}
.breeze-modal-loading {
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 14px;
	background: #fff;
	z-index: 2;
}
.breeze-modal-loading p {
	font-size: 14px;
	color: #888;
	margin: 0;
}
.breeze-spinner {
	width: 36px;
	height: 36px;
	border: 3px solid #e8e8e8;
	border-top-color: #1a73e8;
	border-radius: 50%;
	animation: breeze-spin 0.75s linear infinite;
}
.breeze-modal-iframe {
	width: 100%;
	height: 100%;
	border: none;
	display: block;
	opacity: 0;
	transition: opacity 0.3s ease;
	min-height: 440px;
}

/* ── Footer ─────────────────────────────────────────────────────── */
.breeze-modal-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 20px;
	border-top: 1px solid #f0f0f0;
	background: #fafafa;
	flex-shrink: 0;
	gap: 12px;
}
.breeze-modal-security-badges {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}
.breeze-badge {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 11px;
	color: #666;
	font-weight: 500;
}
.breeze-modal-cancel {
	border: none;
	background: none;
	font-size: 12px;
	color: #999;
	cursor: pointer;
	padding: 4px 0;
	text-decoration: underline;
	white-space: nowrap;
	transition: color 0.15s;
}
.breeze-modal-cancel:hover {
	color: #555;
}

/* ── Body scroll lock ───────────────────────────────────────────── */
body.breeze-modal-active {
	overflow: hidden;
}

/* ── Animations ─────────────────────────────────────────────────── */
@keyframes breeze-fade-in {
	from { opacity: 0; }
	to   { opacity: 1; }
}
@keyframes breeze-slide-up {
	from { opacity: 0; transform: translateY(24px) scale(0.97); }
	to   { opacity: 1; transform: translateY(0)    scale(1);    }
}
@keyframes breeze-spin {
	to { transform: rotate(360deg); }
}

/* ── Place Order button loading state ───────────────────────────── */
#place_order.breeze-btn-loading {
	opacity: 0.65;
	cursor: wait;
}

/* ── 3DS expanded state ─────────────────────────────────────────── */
.breeze-modal-container.is-3ds {
	width: min(95vw, 600px);
	max-height: 98vh;
}
.breeze-modal-container.is-3ds .breeze-modal-iframe {
	min-height: 600px;
}

/* ── Shake animation (validation error) ─────────────────────────── */
@keyframes breeze-shake {
	0%,100% { transform: translateX(0); }
	15%      { transform: translateX(-6px); }
	30%      { transform: translateX(5px); }
	45%      { transform: translateX(-4px); }
	60%      { transform: translateX(3px); }
	75%      { transform: translateX(-2px); }
}
.breeze-modal-container.is-shaking {
	animation: breeze-shake 0.45s ease;
}

/* ── Payment confirmed overlay ──────────────────────────────────── */
.breeze-payment-confirmed {
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 12px;
	background: rgba(255,255,255,0.96);
	z-index: 10;
	opacity: 0;
	transition: opacity 0.3s ease;
	pointer-events: none;
}
.breeze-payment-confirmed.is-visible {
	opacity: 1;
	pointer-events: auto;
}
.breeze-confirm-icon {
	width: 56px;
	height: 56px;
	background: #e8f5e9;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	color: #2e7d32;
	animation: breeze-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}
.breeze-confirm-icon svg {
	width: 28px;
	height: 28px;
}
.breeze-payment-confirmed p {
	margin: 0;
	font-size: 16px;
	font-weight: 600;
	color: #1a1a1a;
}
.breeze-confirm-sub {
	font-size: 13px !important;
	font-weight: 400 !important;
	color: #888 !important;
}
@keyframes breeze-pop {
	from { transform: scale(0.6); opacity: 0; }
	to   { transform: scale(1);   opacity: 1; }
}

/* ── Close/cancel disabled during confirmed state ───────────────── */
.breeze-modal-close:disabled,
.breeze-modal-cancel:disabled {
	opacity: 0.3;
	cursor: not-allowed;
	pointer-events: none;
}

/* ── Mobile ─────────────────────────────────────────────────────── */
@media (max-width: 540px) {
	.breeze-modal-container {
		width: 100%;
		max-height: 100%;
		height: 100%;
		border-radius: 0;
	}
	#${ MODAL_ID }.is-open {
		align-items: flex-end;
	}
	.breeze-modal-container {
		animation-name: breeze-slide-up-mobile;
	}
	@keyframes breeze-slide-up-mobile {
		from { transform: translateY(100%); }
		to   { transform: translateY(0); }
	}
	.breeze-modal-footer {
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
	}
}
		`;

		const style = document.createElement( 'style' );
		style.id = 'breeze-modal-styles';
		style.textContent = css;
		document.head.appendChild( style );
	}

	/* ─────────────────────────────────────────────
	   Boot
	───────────────────────────────────────────── */
	$( function () {
		// Only initialise on checkout pages with Breeze present.
		if ( $( '#payment_method_' + GATEWAY_ID ).length ) {
			init();
		}
	} );

} )( jQuery );
