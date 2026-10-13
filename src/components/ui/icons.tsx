/** The few glyphs the controls draw. currentColor only, so they follow the theme. */

export function CloseGlyph() {
  return (
    <svg className="h-glyph h-glyph--close" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function CheckGlyph() {
  return (
    <svg className="h-glyph h-glyph--check" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M1.8 5.2l2.2 2.2 4.2-4.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronGlyph() {
  return (
    <svg className="h-glyph h-glyph--chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 6.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SearchGlyph() {
  return (
    <svg className="h-glyph h-glyph--search" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function FolderGlyph() {
  return (
    <svg className="h-glyph h-glyph--folder" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusGlyph() {
  return (
    <svg className="h-glyph h-glyph--plus" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
