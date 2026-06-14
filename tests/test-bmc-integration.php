<?php
/**
 * Self-contained test suite for BMC_Integration.
 *
 * Polyfills WordPress and WooCommerce APIs so the class can be loaded without
 * a live WordPress environment. Runs assertions, then exits with code 0 (all
 * pass) or 1 (any failure).
 *
 * Usage: php tests/test-bmc-integration.php
 *
 * @package BreezeModalCheckout
 */

// ── WP/WC polyfills ───────────────────────────────────────────────────────────

define( 'ABSPATH',         '/' );
define( 'BMC_VERSION',     '1.0.0' );
define( 'BMC_PLUGIN_FILE', '/tmp/breeze-modal-checkout.php' );
define( 'BMC_PLUGIN_DIR',  dirname( __DIR__ ) . '/' );
define( 'BMC_PLUGIN_URL',  'http://example.test/' );
define( 'BMC_GATEWAY_ID',  'breeze_payment_gateway' );

// Controllable doubles for functions used inside is_blocks_checkout().
$GLOBALS['_bmc_test_checkout_page_id'] = 1;
$GLOBALS['_bmc_test_has_block']        = false;

function __( $text, $domain = '' ) { return $text; } // phpcs:ignore
function esc_html( $text ) { return htmlspecialchars( $text, ENT_QUOTES, 'UTF-8' ); }
function esc_html__( $text, $domain = '' ) { return htmlspecialchars( $text, ENT_QUOTES, 'UTF-8' ); }
function sanitize_key( $str ) { return preg_replace( '/[^a-z0-9_\-]/', '', strtolower( (string) $str ) ); }
function add_action( $hook, $cb, $priority = 10, $args = 1 ) { /* stub */ }
function add_filter( $hook, $cb, $priority = 10, $args = 1 ) { /* stub */ }
function wc_get_page_id( $key ) { return $GLOBALS['_bmc_test_checkout_page_id']; }
function has_block( $block, $page_id = null ) { return $GLOBALS['_bmc_test_has_block']; }

class WooCommerce {} // phpcs:ignore
class WC_Payment_Gateway { // phpcs:ignore
	public $enabled  = 'yes';
	public $supports = array( 'products' );
	public function get_title() { return 'Breeze'; }
	public function get_description() { return 'Pay securely using Breeze.'; }
}
class WC_Breeze_Payment_Gateway extends WC_Payment_Gateway {} // phpcs:ignore

require_once dirname( __DIR__ ) . '/includes/class-bmc-integration.php';

// ── Assertion helpers ─────────────────────────────────────────────────────────

$_bmc_passed = 0;
$_bmc_failed = 0;

function bmc_ok( $condition, $label ) {
	global $_bmc_passed, $_bmc_failed;
	if ( $condition ) {
		echo "  PASS  {$label}\n";
		$_bmc_passed++;
	} else {
		echo "  FAIL  {$label}\n";
		$_bmc_failed++;
	}
}

function bmc_eq( $expected, $actual, $label ) {
	global $_bmc_passed, $_bmc_failed;
	if ( $expected === $actual ) {
		echo "  PASS  {$label}\n";
		$_bmc_passed++;
	} else {
		echo "  FAIL  {$label}\n";
		printf(
			"        expected: %s\n        actual:   %s\n",
			var_export( $expected, true ),
			var_export( $actual, true )
		);
		$_bmc_failed++;
	}
}

/**
 * Returns an accessible ReflectionMethod for a private BMC_Integration method.
 *
 * @param string $name Method name.
 * @return ReflectionMethod
 */
function bmc_private( $name ) {
	$m = ( new ReflectionClass( 'BMC_Integration' ) )->getMethod( $name );
	$m->setAccessible( true );
	return $m;
}

// Singleton — constructor only calls add_action/add_filter (both stubbed above).
$i = BMC_Integration::instance();

// ─────────────────────────────────────────────────────────────────────────────
// Group 1 — intercept_wc_redirect()
//
// The filter tags Breeze AJAX checkout responses with breeze_modal=true so the
// JS layer knows to open the modal instead of following a redirect.
// ─────────────────────────────────────────────────────────────────────────────
echo "\nGroup 1 — intercept_wc_redirect()\n";

$original = array( 'redirect' => 'https://example.test/order-received/1/' );

// 1a: DOING_AJAX undefined — must pass through untouched.
bmc_eq( $original, $i->intercept_wc_redirect( $original, 1 ), 'pass-through when not in AJAX context' );

define( 'DOING_AJAX', true );

// 1b: AJAX context, but a different action — must still pass through.
$_POST['action'] = 'woocommerce_checkout';
bmc_eq( $original, $i->intercept_wc_redirect( $original, 1 ), 'pass-through for unrelated AJAX action' );

// 1c: AJAX context with our action — must merge breeze_modal=true flag.
$_POST['action'] = 'breeze_create_modal_payment';
$tagged          = $i->intercept_wc_redirect( $original, 1 );
bmc_ok( isset( $tagged['breeze_modal'] ) && true === $tagged['breeze_modal'], 'adds breeze_modal=true for Breeze AJAX action' );
bmc_eq( $original['redirect'], $tagged['redirect'], 'preserves original redirect value in merged result' );

// ─────────────────────────────────────────────────────────────────────────────
// Group 2 — get_payment_notice_message_for_status()
//
// Maps the ?breeze_payment URL parameter value to a user-facing notice string.
// Returns null for any unrecognised value so the caller can suppress the notice.
// ─────────────────────────────────────────────────────────────────────────────
echo "\nGroup 2 — get_payment_notice_message_for_status()\n";

$m = bmc_private( 'get_payment_notice_message_for_status' );

$msg = $m->invoke( $i, 'failed' );
bmc_ok( is_string( $msg ) && strlen( $msg ) > 0, '"failed" returns a non-empty string' );

$msg = $m->invoke( $i, 'cancelled' );
bmc_ok( is_string( $msg ) && strlen( $msg ) > 0, '"cancelled" returns a non-empty string' );

$msg = $m->invoke( $i, 'unknown_status' );
bmc_eq( null, $msg, '"unknown_status" returns null' );

// ─────────────────────────────────────────────────────────────────────────────
// Group 3 — is_blocks_checkout()
//
// Detects whether the checkout page is using WooCommerce Checkout Blocks by
// reading the actual post content (has_block()), rather than checking for the
// presence of the Blocks package class (which exists on shortcode sites too).
// ─────────────────────────────────────────────────────────────────────────────
echo "\nGroup 3 — is_blocks_checkout()\n";

$m = bmc_private( 'is_blocks_checkout' );

// 3a: Page ID <= 0 — early return false even when has_block() would say true.
$GLOBALS['_bmc_test_checkout_page_id'] = -1;
$GLOBALS['_bmc_test_has_block']        = true;
bmc_eq( false, $m->invoke( $i ), 'returns false when checkout page ID is <= 0' );

// 3b: Valid page ID, checkout block absent.
$GLOBALS['_bmc_test_checkout_page_id'] = 10;
$GLOBALS['_bmc_test_has_block']        = false;
bmc_eq( false, $m->invoke( $i ), 'returns false when checkout block is not present' );

// 3c: Valid page ID, checkout block present.
$GLOBALS['_bmc_test_has_block'] = true;
bmc_eq( true, $m->invoke( $i ), 'returns true when checkout block is detected' );

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
echo "\n";
printf( "Results: %d passed, %d failed\n", $_bmc_passed, $_bmc_failed );

exit( $_bmc_failed > 0 ? 1 : 0 );
