# Image Display And Overview Fallback Design

## Goal

Make already-persisted Sorftime and SIF results visibly usable when SellerSprite is unavailable, without re-fetching business data or inventing missing fields. After this display path is verified in production, run one bounded AI image-analysis batch for the current three ASINs.

## Confirmed causes

- Sorftime persisted seven listing images for each current ASIN.
- The browser receives broken images because `amazonMediaSrc()` routes Amazon CDN URLs through `/api/amazon-image`, whose server-side fetch currently returns HTTP 502. The same CDN URL is reachable directly.
- The overview still reads several fields exclusively from the SellerSprite catalog. Sorftime already has a current price trend, rank trend, ratings, sales, and listing images, but only some are projected into the overview.
- Provider diagnostics are copied without restricting them to the current connector, stage, and ASIN set. Historical SellerSprite diagnostics can therefore mark a successful Sorftime Listing stage partial and reduce completeness.

## Design

1. Serve normalized Amazon CDN URLs directly to `<img>` elements. Browser networking follows the user's active proxy/VPN, while `referrerPolicy="no-referrer"` remains in place. The server proxy route is no longer used by normal rendering.
2. Add a pure overview projection that uses SellerSprite values when present and otherwise uses the newest ready Sorftime price/rank point. Source labels must say `MCP 综合`; fields that neither source provides remain explicitly unavailable.
3. Before persisting provider diagnostics, retain only entries matching the invocation's connector, stage, and requested ASINs. Persisted readiness remains the final authority for whether a module is ready.
4. Do not re-fetch the current SIF/Sorftime data. Once tests, review, build, deployment, and a real browser image GET pass, run `image-remarks:sync` once for exactly `B01FHOWYA2,B0855B5Z6F,B08QZWDLP4`. No force refresh and no automatic pipeline re-enable in this change.

## Error handling

- Invalid/empty image URLs render the existing placeholder.
- A missing Sorftime price/rank remains `—`; no fabricated values or category names.
- AI analysis stops on provider authentication, quota, timeout, or malformed output and records the bounded failure. It must not retry the business sync job.

## Acceptance

- All 21 current images render through direct normalized Amazon CDN URLs.
- Current price and rank appear from Sorftime when SellerSprite catalog data is missing.
- SellerSprite-only fields remain visibly unavailable.
- Listing is counted ready for the current three ASINs, and unrelated historical diagnostics are absent.
- AI remarks are produced for the exact current image set only after the display deployment passes.
