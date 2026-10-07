# Cropster

Send coffee products and orders from Swell to Cropster for roast production planning, and see each order's production state in Swell.

## How it works

1. **Sends coffee products.** Each product goes to Cropster with one variant per active Swell variant that has a SKU. The package size (250g, 12 oz, 1 kg, 2 lb…) and grind style are read from the variant's options, with fallbacks from the product and the app settings. Products are sent when they are created or changed, and new products must be reviewed once in Cropster before they can be produced.

2. **Turns orders into production orders.** When an order is paid (or submitted, if you choose), its items with Cropster products are sent to Cropster by SKU as a retail or wholesale production order. Item changes are resent while the order is still open in Cropster.

   | Store event                                         | Cropster                                  |
   | --------------------------------------------------- | ----------------------------------------- |
   | `product.created`, `product.updated`, variant changes | Product and variants created or updated |
   | `order.paid` or `order.submitted`                   | Production order created                  |
   | `order.updated` with item changes                   | Open production order updated             |

3. **Copies production status back.** Every 15 minutes the app reads orders changed in Cropster and shows their state (Open, Scheduled, In progress, Roasted, Completed) on the Cropster tab of each Swell order.

4. **Imports existing data.** The **Cropster sync** page in the dashboard sends existing products and orders page by page, and lists any record that was not sent with the reason. **Send to Cropster** on product and order pages, and on selected records in the lists, sends them right away.

## Setup

In Cropster, open the gear icon → Account → API Access, click **Add service account** and select the `mrp.product` and `mrp.order` scopes (requires the Cropster API Integration add-on). Enter its Client ID and Client Secret in the app settings, check the product option names, and turn on Enable Integration. Open **Cropster sync** in the sidebar and sync products, then orders.
