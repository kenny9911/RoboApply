// JsonLd — renders one structured-data graph built on the server (lib/seo.ts).
// No 'use client' and no server imports: the JSON arrives as a string that
// lib/seo.ts already escaped (`<` → <), so a translation can't close the tag.

export function JsonLd({ json }: { json: string }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
