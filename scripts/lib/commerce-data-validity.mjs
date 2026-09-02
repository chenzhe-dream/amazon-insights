export function positiveMoneyOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function hasCatalogRatingReviewConflict(rating, reviewCount, catalog) {
  return rating === 0
    && reviewCount === 0
    && (typeof catalog?.rating === "number" && catalog.rating > 0
      || typeof catalog?.reviews === "number" && catalog.reviews > 0);
}
