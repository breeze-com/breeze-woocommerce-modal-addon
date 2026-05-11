<?php
/**
 * Plugin Name:       Breeze Modal Addon
 * Plugin URI:        https://breeze.com
 * Description:       Embeds the Breeze payment page in a modal/lightbox at checkout, supporting WooCommerce Checkout Blocks and legacy shortcode. Includes Apple Pay cross-domain support, postMessage event handling, and graceful failure recovery.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Breeze
 * Author URI:        https://breeze.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       breeze-modal-checkout
 * Domain Path:       /languages
 * Requires Plugins:  woocommerce
 *
 * @package BreezeModalCheckout
 */

defined( 'ABSPATH' ) || exit;

// ── Plugin constants ──────────────────────────────────────────────────────────

define( 'BMC_VERSION',     '1.0.0' );
define( 'BMC_PLUGIN_FILE', __FILE__ );
define( 'BMC_PLUGIN_DIR',  plugin_dir_path( __FILE__ ) );
define( 'BMC_PLUGIN_URL',  plugin_dir_url( __FILE__ ) );
define( 'BMC_GATEWAY_ID',  'breeze_payment_gateway' );

// ── Dependency check ──────────────────────────────────────────────────────────

add_action( 'admin_init', 'bmc_check_dependencies' );

function bmc_check_dependencies() {
	$errors = array();

	if ( ! class_exists( 'WooCommerce' ) ) {
		$errors[] = __( 'WooCommerce must be installed and activated.', 'breeze-modal-checkout' );
	}

	if ( ! class_exists( 'WC_Breeze_Payment_Gateway' ) ) {
		$errors[] = __( 'The Breeze Payment Gateway plugin must be installed and activated.', 'breeze-modal-checkout' );
	}

	if ( empty( $errors ) ) {
		return;
	}

	deactivate_plugins( plugin_basename( BMC_PLUGIN_FILE ) );

	add_action( 'admin_notices', function () use ( $errors ) {
		$items = '';
		foreach ( $errors as $error ) {
			$items .= '<li>' . esc_html( $error ) . '</li>';
		}
		printf(
			'<div class="notice notice-error"><p><strong>%s</strong> %s</p><ul>%s</ul></div>',
			esc_html__( 'Breeze Modal Checkout could not be activated.', 'breeze-modal-checkout' ),
			esc_html__( 'The following requirements were not met:', 'breeze-modal-checkout' ),
			$items
		);
	} );
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

add_action( 'plugins_loaded', 'bmc_init', 20 );

function bmc_init() {
	if ( ! class_exists( 'WooCommerce' ) || ! class_exists( 'WC_Breeze_Payment_Gateway' ) ) {
		return;
	}

	require_once BMC_PLUGIN_DIR . 'includes/class-bmc-integration.php';
	BMC_Integration::instance();
}

// ── Activation / Deactivation hooks ──────────────────────────────────────────

register_activation_hook( BMC_PLUGIN_FILE, 'bmc_activate' );

function bmc_activate() {
	flush_rewrite_rules();
}

register_deactivation_hook( BMC_PLUGIN_FILE, 'bmc_deactivate' );

function bmc_deactivate() {
	flush_rewrite_rules();
}
