<?php
/**
 * BMC_Integration
 *
 * Handles both the legacy shortcode checkout and WooCommerce Checkout Blocks.
 *
 * Legacy flow:
 *   intercepts checkout_place_order_{gateway} jQuery event → AJAX → modal
 *
 * Blocks flow:
 *   Blocks creates the order and calls process_payment() itself.
 *   process_payment() returns a redirect URL → we intercept it in JS
 *   via a fetch() patch and open the modal instead.
 *
 * Compatible with PHP 7.4+.
 *
 * @package BreezeModalCheckout
 */

defined( 'ABSPATH' ) || exit;

class BMC_Integration {

	/** @var BMC_Integration|null */
	private static $instance = null;

	/** @return self */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		$this->hooks();
	}

	// ── Hooks ─────────────────────────────────────────────────────────────────

	private function hooks() {
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_scripts' ) );

		// Legacy shortcode AJAX
		add_action( 'wp_ajax_breeze_create_modal_payment',        array( $this, 'ajax_create_payment' ) );
		add_action( 'wp_ajax_nopriv_breeze_create_modal_payment', array( $this, 'ajax_create_payment' ) );
		add_filter( 'woocommerce_payment_successful_result', array( $this, 'intercept_wc_redirect' ), 10, 2 );

		// Clear stale checkout session and show notice when returning after failed/cancelled Breeze payment
		add_action( 'template_redirect', array( $this, 'maybe_clear_checkout_session' ), 1 );
	}

	// ── Script enqueueing ─────────────────────────────────────────────────────

	public function enqueue_scripts() {
		if ( ! is_checkout() ) {
			return;
		}

		$gateways = WC()->payment_gateways()->get_available_payment_gateways();
		if ( ! isset( $gateways[ BMC_GATEWAY_ID ] ) ) {
			return;
		}

		/** @var WC_Payment_Gateway $gateway */
		$gateway = $gateways[ BMC_GATEWAY_ID ];

		// Read and consume any pending payment notice from a previous failed/cancelled attempt
		$session_id     = WC()->session ? WC()->session->get_customer_id() : session_id();
		$transient_key  = 'bmc_notice_' . $session_id;
		$pending_notice = get_transient( $transient_key );
		if ( $pending_notice ) {
			delete_transient( $transient_key );
		}

		// Parse domain for Apple Pay cross-domain certification.
		// Breeze requires the bare domain (no https://) to match the certified domain.
		$site_url    = get_site_url();
		$parsed      = wp_parse_url( $site_url );
		$site_domain = isset( $parsed['host'] ) ? $parsed['host'] : '';

		// Optional theme color from plugin options (future settings page hook)
		$primary_color = get_option( 'bmc_theme_primary_color', '' );

		$shared_data = array(
			'ajaxUrl'       => admin_url( 'admin-ajax.php' ),
			'nonce'         => wp_create_nonce( 'breeze_modal_nonce' ),
			'storeName'     => get_bloginfo( 'name' ),
			'currency'      => get_woocommerce_currency(),
			'checkoutUrl'   => wc_get_checkout_url(),
			'pendingNotice' => $pending_notice ? $pending_notice : '',
			// Apple Pay cross-domain: bare domain sent to Breeze iframe
			// Must match the domain registered with Breeze support for Apple Pay
			'siteDomain'    => $site_domain,
			// Optional: pass a primary color to Breeze iframe theme
			'theme'         => $primary_color ? array( 'primaryColor' => $primary_color ) : null,
			'gatewayData'   => array(
				'title'       => $gateway->get_title(),
				'description' => $gateway->get_description(),
				'enabled'     => 'yes' === $gateway->enabled,
				'supports'    => $gateway->supports,
			),
		);

		if ( $this->is_blocks_checkout() ) {
			// ── Blocks checkout ───────────────────────────────────────────────
			$js_file = BMC_PLUGIN_DIR . 'assets/js/breeze-blocks.js';

			wp_enqueue_script(
				'breeze-modal-blocks',
				BMC_PLUGIN_URL . 'assets/js/breeze-blocks.js',
				array( 'wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities' ),
				file_exists( $js_file ) ? (string) filemtime( $js_file ) : BMC_VERSION,
				true
			);

			wp_localize_script( 'breeze-modal-blocks', 'breezeModalData', $shared_data );

		} else {
			// ── Legacy shortcode checkout ─────────────────────────────────────
			$js_file = BMC_PLUGIN_DIR . 'assets/js/breeze-modal.js';

			wp_enqueue_script(
				'breeze-modal-checkout',
				BMC_PLUGIN_URL . 'assets/js/breeze-modal.js',
				array( 'jquery', 'wc-checkout' ),
				file_exists( $js_file ) ? (string) filemtime( $js_file ) : BMC_VERSION,
				true
			);

			wp_localize_script( 'breeze-modal-checkout', 'breezeModalData', $shared_data );
		}
	}

	/**
	 * Detect whether the current checkout page is using Checkout Blocks.
	 * WooCommerce sets a flag when the Checkout block is active.
	 *
	 * @return bool
	 */
	private function is_blocks_checkout() {
		// has_block() is available since WordPress 5.0 — always use it.
		// It reads the actual post content of the checkout page, so it's
		// accurate regardless of whether the Blocks package class exists.
		// The class_exists() check on Automattic\WooCommerce\Blocks\Package
		// is NOT reliable — that class is bundled with WooCommerce 6.0+ and
		// will exist even on shortcode-only checkouts.
		if ( ! function_exists( 'has_block' ) ) {
			return false; // Very old WP — safe to assume shortcode.
		}

		$checkout_page_id = wc_get_page_id( 'checkout' );
		if ( ! $checkout_page_id || $checkout_page_id < 1 ) {
			return false;
		}

		return has_block( 'woocommerce/checkout', $checkout_page_id );
	}

	// ── Legacy AJAX handler ───────────────────────────────────────────────────

	public function ajax_create_payment() {
		if ( ! check_ajax_referer( 'breeze_modal_nonce', 'nonce', false ) ) {
			wp_send_json_error(
				array( 'message' => __( 'Security check failed. Please refresh and try again.', 'breeze-modal-checkout' ) ),
				403
			);
		}

		$raw_form = isset( $_POST['form'] ) ? wp_unslash( $_POST['form'] ) : ''; // phpcs:ignore
		parse_str( $raw_form, $form_data );
		foreach ( $form_data as $key => $value ) {
			$_POST[ $key ] = $value;
		}

		$order_id = $this->process_wc_checkout();

		if ( is_wp_error( $order_id ) ) {
			wp_send_json_error( array( 'message' => $order_id->get_error_message() ) );
		}
		if ( ! $order_id ) {
			wp_send_json_error( array( 'message' => __( 'Could not create order. Please try again.', 'breeze-modal-checkout' ) ) );
		}

		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			wp_send_json_error( array( 'message' => __( 'Order not found after creation.', 'breeze-modal-checkout' ) ) );
		}

		$gateway = $this->get_gateway();
		if ( ! $gateway ) {
			wp_send_json_error( array( 'message' => __( 'Breeze gateway is not available.', 'breeze-modal-checkout' ) ) );
		}

		$payment_page = $this->create_breeze_payment_page( $gateway, $order );

		if ( is_wp_error( $payment_page ) ) {
			$order->update_status( 'cancelled', __( 'Breeze payment page creation failed.', 'breeze-modal-checkout' ) );
			wp_send_json_error( array( 'message' => $payment_page->get_error_message() ) );
		}

		wp_send_json_success( array(
			'paymentUrl' => $payment_page['url'],
			'orderId'    => $order_id,
		) );
	}

	// ── WC checkout processing (legacy only) ──────────────────────────────────

	/** @return int|WP_Error */
	private function process_wc_checkout() {
		$captured_order_id = 0;
		$captured_error    = null;

		$intercept = function ( $result ) use ( &$captured_order_id ) {
			if ( isset( $result['order_id'] ) ) {
				$captured_order_id = (int) $result['order_id'];
			}
			return $result;
		};
		add_filter( 'woocommerce_payment_successful_result', $intercept, PHP_INT_MAX );

		$error_intercept = function ( $message ) use ( &$captured_error ) {
			$captured_error = $message;
		};
		add_action( 'woocommerce_checkout_order_exception', $error_intercept );

		if ( ! isset( $_POST['woocommerce-process-checkout-nonce'] ) ) {
			$_POST['woocommerce-process-checkout-nonce'] = wp_create_nonce( 'woocommerce-process_checkout' );
		}

		ob_start();
		try {
			WC()->checkout()->process_checkout();
		} catch ( Exception $e ) {
			ob_end_clean();
			remove_filter( 'woocommerce_payment_successful_result', $intercept, PHP_INT_MAX );
			return new WP_Error( 'checkout_exception', $e->getMessage() );
		}
		ob_end_clean();

		remove_filter( 'woocommerce_payment_successful_result', $intercept, PHP_INT_MAX );
		remove_action( 'woocommerce_checkout_order_exception', $error_intercept );

		if ( $captured_error ) {
			return new WP_Error( 'checkout_error', wp_strip_all_tags( $captured_error ) );
		}

		$notices = wc_get_notices( 'error' );
		if ( ! empty( $notices ) ) {
			$messages = array();
			foreach ( $notices as $n ) {
				$messages[] = wp_strip_all_tags( is_array( $n ) ? ( isset( $n['notice'] ) ? $n['notice'] : '' ) : $n );
			}
			wc_clear_notices();
			return new WP_Error( 'checkout_validation', implode( ' ', array_filter( $messages ) ) );
		}

		if ( ! $captured_order_id ) {
			return new WP_Error( 'no_order', __( 'Order could not be created.', 'breeze-modal-checkout' ) );
		}

		return $captured_order_id;
	}

	// ── Breeze API: create payment page (legacy only) ─────────────────────────

	/**
	 * @param WC_Breeze_Payment_Gateway $gateway
	 * @param WC_Order                  $order
	 * @return array|WP_Error
	 */
	private function create_breeze_payment_page( $gateway, $order ) {
		try {
			$ref = new ReflectionClass( $gateway );

			$build = $ref->getMethod( 'build_line_items' );
			$build->setAccessible( true );
			$line_items = $build->invoke( $gateway, $order );

			if ( empty( $line_items ) ) {
				return new WP_Error( 'no_line_items', __( 'Failed to build line items for Breeze.', 'breeze-modal-checkout' ) );
			}

			$create = $ref->getMethod( 'create_breeze_payment_page' );
			$create->setAccessible( true );
			$payment_page = $create->invoke( $gateway, $order, $line_items );

		} catch ( ReflectionException $e ) {
			return new WP_Error( 'reflection_error', $e->getMessage() );
		} catch ( Exception $e ) {
			return new WP_Error( 'breeze_api_error', $e->getMessage() );
		}

		if ( ! $payment_page || empty( $payment_page['url'] ) ) {
			return new WP_Error( 'breeze_no_url', __( 'Breeze did not return a payment URL.', 'breeze-modal-checkout' ) );
		}

		if ( ! empty( $payment_page['id'] ) ) {
			$order->update_meta_data( '_breeze_payment_page_id', $payment_page['id'] );
		}
		$order->update_status( 'pending', __( 'Awaiting Breeze payment (modal flow).', 'breeze-modal-checkout' ) );
		$order->save();

		return $payment_page;
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	/** @return WC_Breeze_Payment_Gateway|null */
	private function get_gateway() {
		$gateways = WC()->payment_gateways()->payment_gateways();
		$gateway  = isset( $gateways[ BMC_GATEWAY_ID ] ) ? $gateways[ BMC_GATEWAY_ID ] : null;
		return ( $gateway instanceof WC_Breeze_Payment_Gateway ) ? $gateway : null;
	}

	/** @param array $result @param int $order_id @return array */
	public function intercept_wc_redirect( $result, $order_id ) {
		if ( ! ( defined( 'DOING_AJAX' ) && DOING_AJAX ) ) {
			return $result;
		}
		$action = isset( $_POST['action'] ) ? sanitize_key( $_POST['action'] ) : ''; // phpcs:ignore
		if ( 'breeze_create_modal_payment' !== $action ) {
			return $result;
		}
		return array_merge( $result, array( 'breeze_modal' => true ) );
	}

	/**
	 * Returns the notice message stored in the transient for this session, or null.
	 * Deletes the transient immediately after reading (show once).
	 *
	 * @return string|null
	 */
	private function get_payment_notice_message() {
		$session_id = WC()->session ? WC()->session->get_customer_id() : session_id();
		$key        = 'bmc_notice_' . $session_id;
		$message    = get_transient( $key );

		if ( $message ) {
			delete_transient( $key );
			return $message;
		}

		return null;
	}

	/**
	 * Show WC error notice on shortcode checkout page.
	 */
	public function maybe_show_payment_failed_notice() {
		$message = $this->get_payment_notice_message();
		if ( ! $message ) {
			return;
		}
		wc_add_notice( $message, 'error' );
	}



	/**
	 * Intercepts the checkout page load when returning after a failed/cancelled
	 * Breeze payment.
	 *
	 * The ?breeze_payment param triggers this. We store the message in a transient,
	 * then redirect to a clean checkout URL (no query params). This prevents WC Blocks
	 * from seeing the URL param during hydration, which was causing the loading loop —
	 * Blocks was trying to reconcile the stale pending order state with the current URL.
	 *
	 * Runs on template_redirect priority 1 — before Blocks boots.
	 */
	public function maybe_clear_checkout_session() {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( ! isset( $_GET['breeze_payment'] ) ) {
			return;
		}

		if ( ! is_checkout() ) {
			return;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$status  = sanitize_key( $_GET['breeze_payment'] );
		$message = $this->get_payment_notice_message_for_status( $status );

		if ( $message ) {
			$session_id = WC()->session ? WC()->session->get_customer_id() : session_id();
			set_transient( 'bmc_notice_' . $session_id, $message, 120 );
		}

		// Cancel and trash the draft order that WC Blocks Store API created.
		// This is the key step — Blocks persists a draft order server-side and
		// resumes it on every page load via the session. If we don't cancel it,
		// Blocks picks it up, tries to process the pending payment, and stalls.
		if ( WC()->session ) {
			$draft_order_id = WC()->session->get( 'store_api_draft_order' );

			if ( ! $draft_order_id ) {
				// WC Blocks also stores it under this key in some versions
				$draft_order_id = WC()->session->get( 'order_awaiting_payment' );
			}

			if ( $draft_order_id ) {
				$draft_order = wc_get_order( $draft_order_id );
				if ( $draft_order && $draft_order->has_status( array( 'pending', 'draft', 'checkout-draft' ) ) ) {
					$draft_order->update_status( 'cancelled', __( 'Breeze payment cancelled or failed — order reset.', 'breeze-modal-checkout' ) );
				}
			}

			// Clear all session keys Blocks uses to track checkout state
			WC()->session->set( 'store_api_draft_order',  null );
			WC()->session->set( 'order_awaiting_payment', null );
			WC()->session->set( 'chosen_payment_method',  null );
		}

		// Redirect to clean checkout URL so Blocks hydrates with no stale state
		wp_safe_redirect( wc_get_checkout_url() );
		exit;
	}

	/**
	 * Returns notice message for a given status string.
	 *
	 * @param string $status
	 * @return string|null
	 */
	private function get_payment_notice_message_for_status( $status ) {
		if ( $status === 'failed' ) {
			return __( 'Your payment was not completed. Please try again or choose a different payment method.', 'breeze-modal-checkout' );
		}
		if ( $status === 'cancelled' ) {
			return __( 'Payment cancelled. Your order has not been placed.', 'breeze-modal-checkout' );
		}
		return null;
	}

}
