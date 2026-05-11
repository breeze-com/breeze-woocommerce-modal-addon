=== Breeze Modal Addon ===
Contributors: breeze
Tags: woocommerce, breeze, payment, checkout, modal, apple pay
Requires at least: 6.0
Tested up to: 6.7
Stable tag: 1.0.0
Requires PHP: 7.4
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Embeds the Breeze payment page in a modal at checkout instead of redirecting — supports WooCommerce Checkout Blocks, legacy shortcode, and Apple Pay.

== Description ==

Breeze Modal Addon intercepts the standard Breeze gateway redirect and opens the Breeze-hosted payment page inside a polished modal/lightbox. Customers complete payment without leaving your checkout page.

**Supports both checkout modes:**

* WooCommerce Checkout Blocks (default in WooCommerce 8.3+)
* Legacy shortcode checkout (`[woocommerce_checkout]`)

**Features:**

* No full-page redirect — payment happens inside a modal
* Apple Pay cross-domain support — passes your domain certification to the Breeze iframe automatically
* postMessage integration — reacts to Breeze iframe events in real time:
  * Shows a "Payment confirmed!" overlay the moment card/Apple Pay/Google Pay succeeds
  * Expands the modal automatically when a 3DS challenge is triggered
  * Subtle shake animation on card validation errors
* Graceful failure handling — failed or cancelled payments reload a fresh checkout with a clear error notice; the Place Order button is always available for retry
* Graceful fallback URL polling for crypto payments
* Mobile-responsive — full-screen sheet on small viewports
* Accessible — focus trap, ARIA attributes, keyboard (Escape) to close
* Nonce-secured AJAX for legacy checkout flow

**Requirements:**

* WooCommerce 6.0+
* Breeze Payment Gateway plugin (active and configured)
* PHP 7.4+

**Apple Pay setup:**

To enable Apple Pay in the embedded modal, email Breeze support to request domain certification for your store URL. Once received, host the certification file at:
`yourdomain.com/.well-known/apple-developer-merchantid-domain-association.txt`

The plugin handles the `cross_domain_name` iframe parameter and `request-global-config` postMessage response automatically.

== Installation ==

1. Upload the `breeze-modal-plugin` folder to `/wp-content/plugins/`
2. Activate the plugin through the **Plugins** menu in WordPress
3. Ensure the Breeze Payment Gateway plugin is installed, activated, and configured with a valid API key
4. No additional configuration needed — the modal activates automatically on checkout

== Frequently Asked Questions ==

= Does this work with WooCommerce Checkout Blocks? =

Yes — this is the primary supported checkout mode. The plugin registers a fetch() interceptor that catches the Breeze redirect URL from the WooCommerce Store API response and opens it in a modal instead.

= Does this work with the legacy shortcode checkout? =

Yes — the plugin detects which checkout mode is active and loads the appropriate script. The legacy flow uses a WooCommerce jQuery hook to intercept form submission.

= How does Apple Pay work in the modal? =

The plugin automatically appends `?cross_domain_name=yourdomain.com` to the Breeze iframe URL and responds to Breeze's `request-global-config` postMessage with `applePayEnabled: true`. You still need to request domain certification from Breeze support and host the certificate file on your domain.

= What happens when a payment fails or is cancelled? =

The modal closes, the stale draft order is cancelled server-side, and the customer is redirected to a fresh checkout page with an error notice. The Place Order button is fully functional for retry.

= What happens if the customer closes the modal before paying? =

Same as a cancellation — the draft order is cancelled and the customer is returned to a fresh checkout with a notice that the payment was cancelled.

== Changelog ==

= 1.0.0 =
* Initial release
* WooCommerce Checkout Blocks support via Store API fetch() intercept
* Legacy shortcode checkout support
* Apple Pay cross-domain support via cross_domain_name and request-global-config postMessage
* 3DS challenge auto-expansion
* Payment confirmed overlay on postMessage success events
* Failed/cancelled payment recovery with session clearing and fresh checkout reload
* Crypto payment fallback via iframe URL polling

== Upgrade Notice ==

= 1.0.0 =
Initial release.
