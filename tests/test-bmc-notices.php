<?php
/**
 * Standalone test harness — BMC notice-message mapping and session-clearing logic
 *
 * Covers:
 *   - get_payment_notice_message_for_status() via Reflection (private pure function)
 *   - maybe_clear_checkout_session() early-return paths
 *   - maybe_clear_checkout_session() full flow: transient set, draft order cancelled, redirect
 *
 * Runner : php tests/test-bmc-notices.php
 * Exit   : 0 all pass · 1 any failure
 *
 * Self-contained — polyfills all WP/WC dependencies, no WordPress install needed.
 * Designed to run independently of tests/test-bmc-integration.php (different file,
 * no shared state, separate PHP process).
 */

defined( 'ABSPATH' ) || define( 'ABSPATH', dirname( __DIR__ ) . '/' );

define( 'BMC_VERSION',    '1.0.0' );
define( 'BMC_PLUGIN_FILE', ABSPATH . 'breeze-modal-checkout.php' );
define( 'BMC_PLUGIN_DIR',  ABSPATH );
define( 'BMC_PLUGIN_URL',  'http://localhost/wp-content/plugins/breeze-modal-checkout/' );
define( 'BMC_GATEWAY_ID',  'breeze_payment_gateway' );

// ── Controllable test globals ────────────────────────────────────────────────

$GLOBALS['_bmc_test_is_checkout']            = true;
$GLOBALS['_bmc_test_transients']             = array();
$GLOBALS['_bmc_test_order_stub']             = null; // array('id'=>N,'obj'=>BMC_Test_Order)
$GLOBALS['_bmc_test_wp_safe_redirect_called'] = false;

// ── WP stub functions ────────────────────────────────────────────────────────

function add_action( $hook, $callback, $priority = 10, $accepted_args = 1 ) {}
function add_filter( $hook, $callback, $priority = 10, $accepted_args = 1 ) {}
function do_action( ...$args ) {}
function apply_filters( $tag, $value ) { return $value; }

function __( $text, $domain = '' ) { return $text; }
function _e( $text, $domain = '' ) { echo $text; }

function sanitize_key( $key ) {
	return preg_replace( '/[^a-z0-9_\-]/', '', strtolower( $key ) );
}

function is_checkout() {
	return (bool) $GLOBALS['_bmc_test_is_checkout'];
}

function wc_get_checkout_url() {
	return 'http://localhost/checkout/';
}

function wc_get_order( $id ) {
	if ( $id && $GLOBALS['_bmc_test_order_stub'] ) {
		$stub = $GLOBALS['_bmc_test_order_stub'];
		if ( $stub['id'] === $id ) {
			return $stub['obj'];
		}
	}
	return null;
}

function get_transient( $key ) {
	return isset( $GLOBALS['_bmc_test_transients'][ $key ] )
		? $GLOBALS['_bmc_test_transients'][ $key ]
		: false;
}

function set_transient( $key, $value, $expiry = 0 ) {
	$GLOBALS['_bmc_test_transients'][ $key ] = $value;
	return true;
}

function delete_transient( $key ) {
	unset( $GLOBALS['_bmc_test_transients'][ $key ] );
	return true;
}

/**
 * Override wp_safe_redirect to throw instead of redirecting.
 * Lets tests assert on the target URL without calling exit.
 */
class BMC_Test_RedirectException extends RuntimeException {}

function wp_safe_redirect( $url, $status = 302, $x_redirect_by = 'WordPress' ) {
	$GLOBALS['_bmc_test_wp_safe_redirect_called'] = true;
	throw new BMC_Test_RedirectException( $url );
}

// ── WC class stubs ───────────────────────────────────────────────────────────

class BMC_Test_Session {
	private $data = array();

	public function __construct( $data = array() ) {
		$this->data = $data;
	}

	public function get_customer_id() {
		return 'test_customer_123';
	}

	public function get( $key ) {
		return isset( $this->data[ $key ] ) ? $this->data[ $key ] : null;
	}

	public function set( $key, $value ) {
		$this->data[ $key ] = $value;
	}
}

class BMC_Test_Order {
	public $status;
	public $cancel_called = false;

	public function __construct( $status = 'pending' ) {
		$this->status = $status;
	}

	public function has_status( $statuses ) {
		return in_array( $this->status, (array) $statuses, true );
	}

	public function update_status( $new_status, $note = '' ) {
		$this->status       = $new_status;
		$this->cancel_called = true;
	}
}

class WC_Payment_Gateway {}
class WC_Breeze_Payment_Gateway extends WC_Payment_Gateway {}

class WooCommerce {
	public $session = null;

	public function payment_gateways() {
		return new class {
			public function payment_gateways() { return array(); }
		};
	}
}

$_wc_instance = new WooCommerce();

function WC() {
	return $GLOBALS['_wc_instance'];
}

// ── Assertion helpers ────────────────────────────────────────────────────────

$pass = 0;
$fail = 0;

function assert_true( $condition, $label ) {
	global $pass, $fail;
	if ( $condition ) {
		echo "  PASS: $label\n";
		$pass++;
	} else {
		echo "  FAIL: $label\n";
		$fail++;
	}
}

function assert_equals( $expected, $actual, $label ) {
	global $pass, $fail;
	if ( $expected === $actual ) {
		echo "  PASS: $label\n";
		$pass++;
	} else {
		$exp = var_export( $expected, true );
		$got = var_export( $actual, true );
		echo "  FAIL: $label (expected $exp, got $got)\n";
		$fail++;
	}
}

// ── Load the class under test ────────────────────────────────────────────────

require_once ABSPATH . 'includes/class-bmc-integration.php';

/** Reset singleton between groups so each group gets a fresh instance. */
function reset_singleton() {
	$ref  = new ReflectionClass( 'BMC_Integration' );
	$prop = $ref->getProperty( 'instance' );
	$prop->setAccessible( true );
	$prop->setValue( null, null );
}

// ════════════════════════════════════════════════════════════════════════════
// Group 1 — get_payment_notice_message_for_status() (private, via Reflection)
// ════════════════════════════════════════════════════════════════════════════

echo "\nGroup 1: get_payment_notice_message_for_status\n";

reset_singleton();
$integration = BMC_Integration::instance();
$ref_class   = new ReflectionClass( $integration );
$ref_method  = $ref_class->getMethod( 'get_payment_notice_message_for_status' );
$ref_method->setAccessible( true );

$msg_failed    = $ref_method->invoke( $integration, 'failed' );
$msg_cancelled = $ref_method->invoke( $integration, 'cancelled' );
$msg_unknown   = $ref_method->invoke( $integration, 'foobar' );

assert_true(
	is_string( $msg_failed ) && strlen( $msg_failed ) > 5,
	"'failed' status returns a non-empty string"
);
assert_true(
	is_string( $msg_cancelled ) && strlen( $msg_cancelled ) > 5,
	"'cancelled' status returns a non-empty string"
);
assert_equals(
	null,
	$msg_unknown,
	"Unknown status returns null"
);
assert_true(
	stripos( $msg_failed, 'payment' ) !== false || stripos( $msg_failed, 'try again' ) !== false,
	"'failed' message refers to payment or retry"
);
assert_true(
	stripos( $msg_cancelled, 'cancel' ) !== false,
	"'cancelled' message mentions cancellation"
);

// ════════════════════════════════════════════════════════════════════════════
// Group 2 — maybe_clear_checkout_session: early-return paths
// ════════════════════════════════════════════════════════════════════════════

echo "\nGroup 2: maybe_clear_checkout_session — early returns\n";

// No breeze_payment param → function returns without redirect.
reset_singleton();
$_GET = array();
$GLOBALS['_bmc_test_wp_safe_redirect_called'] = false;
$integration = BMC_Integration::instance();

try {
	$integration->maybe_clear_checkout_session();
	assert_true(
		! $GLOBALS['_bmc_test_wp_safe_redirect_called'],
		'No redirect when breeze_payment param is absent'
	);
} catch ( BMC_Test_RedirectException $e ) {
	assert_true( false, 'No redirect when breeze_payment param is absent (unexpected redirect)' );
}

// breeze_payment present but is_checkout() is false → function returns without redirect.
reset_singleton();
$_GET = array( 'breeze_payment' => 'failed' );
$GLOBALS['_bmc_test_is_checkout']             = false;
$GLOBALS['_bmc_test_wp_safe_redirect_called'] = false;
$integration = BMC_Integration::instance();

try {
	$integration->maybe_clear_checkout_session();
	assert_true(
		! $GLOBALS['_bmc_test_wp_safe_redirect_called'],
		'No redirect when breeze_payment present but not on checkout page'
	);
} catch ( BMC_Test_RedirectException $e ) {
	assert_true( false, 'No redirect when not on checkout (unexpected redirect)' );
}

$GLOBALS['_bmc_test_is_checkout'] = true; // restore

// ════════════════════════════════════════════════════════════════════════════
// Group 3 — maybe_clear_checkout_session: transient + redirect
// ════════════════════════════════════════════════════════════════════════════

echo "\nGroup 3: maybe_clear_checkout_session — transient and redirect\n";

$transient_key = 'bmc_notice_test_customer_123'; // 'bmc_notice_' . get_customer_id()

// 'failed' status → transient set, redirect to clean checkout URL.
reset_singleton();
$_GET                            = array( 'breeze_payment' => 'failed' );
$GLOBALS['_bmc_test_transients'] = array();
$GLOBALS['_bmc_test_order_stub'] = null;

$_wc_instance          = new WooCommerce();
$_wc_instance->session = new BMC_Test_Session();
$integration           = BMC_Integration::instance();

$redirect_url = null;
try {
	$integration->maybe_clear_checkout_session();
	assert_true( false, "'failed': expected redirect (no exception thrown)" );
} catch ( BMC_Test_RedirectException $e ) {
	$redirect_url = $e->getMessage();
	assert_equals(
		'http://localhost/checkout/',
		$redirect_url,
		"'failed' status redirects to clean checkout URL"
	);
}
assert_true(
	! empty( $GLOBALS['_bmc_test_transients'][ $transient_key ] ),
	"'failed' status stores a notice transient for the session"
);

// 'cancelled' status → transient set, redirect.
reset_singleton();
$_GET                            = array( 'breeze_payment' => 'cancelled' );
$GLOBALS['_bmc_test_transients'] = array();

$_wc_instance          = new WooCommerce();
$_wc_instance->session = new BMC_Test_Session();
$integration           = BMC_Integration::instance();

try {
	$integration->maybe_clear_checkout_session();
	assert_true( false, "'cancelled': expected redirect (no exception thrown)" );
} catch ( BMC_Test_RedirectException $e ) {
	assert_equals(
		'http://localhost/checkout/',
		$e->getMessage(),
		"'cancelled' status redirects to clean checkout URL"
	);
}
assert_true(
	! empty( $GLOBALS['_bmc_test_transients'][ $transient_key ] ),
	"'cancelled' status stores a notice transient for the session"
);

// Unknown status → no transient, but still redirects.
reset_singleton();
$_GET                            = array( 'breeze_payment' => 'unknown_xyz' );
$GLOBALS['_bmc_test_transients'] = array();

$_wc_instance          = new WooCommerce();
$_wc_instance->session = new BMC_Test_Session();
$integration           = BMC_Integration::instance();

try {
	$integration->maybe_clear_checkout_session();
	assert_true( false, "Unknown status: expected redirect (no exception thrown)" );
} catch ( BMC_Test_RedirectException $e ) {
	assert_equals(
		'http://localhost/checkout/',
		$e->getMessage(),
		"Unknown status still redirects to checkout URL"
	);
}
assert_equals(
	null,
	isset( $GLOBALS['_bmc_test_transients'][ $transient_key ] )
		? $GLOBALS['_bmc_test_transients'][ $transient_key ]
		: null,
	"Unknown status does NOT store a notice transient"
);

// ════════════════════════════════════════════════════════════════════════════
// Group 4 — maybe_clear_checkout_session: draft order cancellation
// ════════════════════════════════════════════════════════════════════════════

echo "\nGroup 4: maybe_clear_checkout_session — draft order handling\n";

// Draft order with 'pending' status → must be cancelled before redirect.
reset_singleton();
$_GET                            = array( 'breeze_payment' => 'cancelled' );
$GLOBALS['_bmc_test_transients'] = array();

$draft_order                     = new BMC_Test_Order( 'pending' );
$GLOBALS['_bmc_test_order_stub'] = array( 'id' => 42, 'obj' => $draft_order );

$_wc_instance          = new WooCommerce();
$_wc_instance->session = new BMC_Test_Session( array(
	'store_api_draft_order'  => 42,
	'order_awaiting_payment' => null,
) );
$integration = BMC_Integration::instance();

try {
	$integration->maybe_clear_checkout_session();
} catch ( BMC_Test_RedirectException $e ) {
	// Expected — inspect order state after session clearing.
}
assert_true(
	$draft_order->cancel_called,
	"Draft order (pending) is cancelled before redirect"
);
assert_equals(
	'cancelled',
	$draft_order->status,
	"Draft order status is updated to 'cancelled'"
);

// Draft order with 'completed' status → must NOT be cancelled.
reset_singleton();
$_GET                            = array( 'breeze_payment' => 'cancelled' );

$completed_order                 = new BMC_Test_Order( 'completed' );
$GLOBALS['_bmc_test_order_stub'] = array( 'id' => 99, 'obj' => $completed_order );

$_wc_instance          = new WooCommerce();
$_wc_instance->session = new BMC_Test_Session( array(
	'store_api_draft_order'  => 99,
	'order_awaiting_payment' => null,
) );
$integration = BMC_Integration::instance();

try {
	$integration->maybe_clear_checkout_session();
} catch ( BMC_Test_RedirectException $e ) {}

assert_true(
	! $completed_order->cancel_called,
	"Completed order is NOT cancelled (only pending/draft/checkout-draft qualify)"
);

// Fallback key 'order_awaiting_payment' used when 'store_api_draft_order' is absent.
reset_singleton();
$_GET                            = array( 'breeze_payment' => 'failed' );
$GLOBALS['_bmc_test_transients'] = array();

$fallback_order                  = new BMC_Test_Order( 'checkout-draft' );
$GLOBALS['_bmc_test_order_stub'] = array( 'id' => 77, 'obj' => $fallback_order );

$_wc_instance          = new WooCommerce();
$_wc_instance->session = new BMC_Test_Session( array(
	'store_api_draft_order'  => null,
	'order_awaiting_payment' => 77,   // fallback key
) );
$integration = BMC_Integration::instance();

try {
	$integration->maybe_clear_checkout_session();
} catch ( BMC_Test_RedirectException $e ) {}

assert_true(
	$fallback_order->cancel_called,
	"Draft order found via fallback key 'order_awaiting_payment' is also cancelled"
);

// ════════════════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════════════════

echo "\n--- Results: $pass passed, $fail failed ---\n";
exit( $fail > 0 ? 1 : 0 );
