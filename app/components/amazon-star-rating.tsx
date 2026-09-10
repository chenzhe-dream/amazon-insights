export function AmazonStarRating({ rating, compact = false }: { rating: number; compact?: boolean }) {
  const clamped = Math.max(0, Math.min(5, rating));
  return (
    <div
      className={compact ? "amazon-star-rating amazon-star-rating-compact" : "amazon-star-rating"}
      aria-label={`${clamped.toFixed(1)} 星，满分 5 星`}
    >
      <span className="amazon-star-rating-stars" aria-hidden="true">
        <span className="amazon-star-rating-base">★★★★★</span>
        <span className="amazon-star-rating-fill" style={{ width: `${(clamped / 5) * 100}%` }}>★★★★★</span>
      </span>
      {!compact ? <span className="amazon-star-rating-value">{clamped.toFixed(1)}</span> : null}
    </div>
  );
}

export function RatingCell({ rating, reviews }: { rating: number; reviews: number | null }) {
  return (
    <div className="rating-cell">
      <AmazonStarRating rating={rating} />
      {reviews !== null && <small>{reviews.toLocaleString()} 条</small>}
    </div>
  );
}
