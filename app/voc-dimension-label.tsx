export function VocDimensionLabel({ label, description }: { label: string; description?: string }) {
  return (
    <>
      <span className="voc-dimension-title">{label}</span>
      {description ? <small className="voc-dimension-desc">{description}</small> : null}
    </>
  );
}
