'use client';

// SponsorshipFacts — the employer's public sponsorship records on the job page
// (MARKET_STRATEGY JI-11): certified H-1B labor condition applications (US
// Department of Labor), H-1B petitions approved and denied (USCIS H-1B Employer
// Data Hub) and the UK sponsor licence (Register of licensed sponsors).
//
// Rules of this block (D3):
//   - every line is a fact about the EMPLOYER, with its year or register, the
//     publication it comes from (a link to the publication's page), the file
//     and its date. A line is built only from what the answer carries;
//   - it never says the job sponsors. Statements about a job stay the job's
//     own quoted lines and badges above; the disclaimer says the two apart;
//   - no facts → nothing is rendered: an empty list says nothing about the
//     employer either way, so there is no "no records" line;
//   - RoboApply only (flag `h1bHistory`, as the route): GoApply never asks and
//     never renders it. While the answer is loading, and when the request
//     fails, nothing is rendered either: the job page does not depend on it;
//   - the UK register's licence asks for an acknowledgement wherever its
//     information is shown: the licence's own sentence is printed with the
//     fact, linked to the licence (server data, like the source names).
//
// For a viewer whose own answers say they need sponsorship in the job's country
// (the rule the feed's sponsorship badges use; decided by the server) the block
// is open. For everyone else it is one line that opens it.
//
// The block sits above the posting's own text, so it stays short: it shows the
// newest fiscal year of each US source and the UK entry (three lines at most)
// and keeps the earlier fiscal years behind one line ("8 records from earlier
// fiscal years"). Nothing is dropped: every earlier line is there with its own
// source, file and date. An employer with ten years of records would otherwise
// push the job description about two phone screens down.

import { useQuery } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';

import { companySponsorshipKey, getCompanySponsorship, type CompanySponsorshipResponse, type SponsorshipFact, type SponsorshipFactSource } from '../../../lib/api/companyFacts';
import { useFlag } from '../../../lib/flags';
import { validDate } from './format';
import styles from './job.module.css';

export interface SponsorshipFactsProps {
  /** The job's company record; null when the job has none (nothing is asked or shown). */
  companyId: string | null;
  companyName: string;
  /** The job page the facts are shown on. */
  jobId: string;
}

// A link inside a sentence: the job page's link style (job.module.css `.linkBtn`: action colour, underlined)
// without the side padding it has as a button. A class of the module is needed here: the global `a` rule
// (inherit colour, no underline) is unlayered and would win over a utility class.
const INLINE_LINK = { padding: 0 } as const;
// A line that opens something (the block itself, or its earlier fiscal years): a 44px target in the same link
// style (utilities apply to a summary).
const SUMMARY = 'cursor-pointer py-3 font-semibold text-action underline underline-offset-2';

/** Only http(s) addresses become links. */
function safeHref(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** A stable key: one line per kind and year (the UK register has one line). */
function factKey(fact: SponsorshipFact): string {
  return fact.kind === 'uk_sponsor_register' ? fact.kind : `${fact.kind}:${fact.fiscalYear}`;
}

/**
 * The lines shown at once and the ones behind "earlier fiscal years": the
 * newest fiscal year of each US source and the UK entry are shown, every other
 * year is earlier. Both lists keep the order of the answer.
 */
export function splitFacts(facts: readonly SponsorshipFact[]): { shown: SponsorshipFact[]; earlier: SponsorshipFact[] } {
  const newest = new Map<SponsorshipFact['kind'], number>();
  for (const fact of facts) {
    if (fact.kind !== 'uk_sponsor_register') newest.set(fact.kind, Math.max(newest.get(fact.kind) ?? Number.NEGATIVE_INFINITY, fact.fiscalYear));
  }
  const shown: SponsorshipFact[] = [];
  const earlier: SponsorshipFact[] = [];
  for (const fact of facts) (fact.kind === 'uk_sponsor_register' || fact.fiscalYear === newest.get(fact.kind) ? shown : earlier).push(fact);
  return { shown, earlier };
}

type Translate = ReturnType<typeof useTranslations>;
type Formatter = ReturnType<typeof useFormatter>;
/** The one translator and formatter of the block, handed to its parts. */
interface Words {
  t: Translate;
  format: Formatter;
}

function SourceLine({ source, listedAs, t, format }: Words & { source: SponsorshipFactSource; listedAs: string | null }) {
  const href = safeHref(source.url);
  const asOf = validDate(source.asOf);
  const attributionHref = safeHref(source.attribution?.url);
  return (
    <>
      <p className={`${styles.muted} break-words`} data-part="source">
        {listedAs ? <>{t('listedAs', { name: listedAs })} · </> : null}
        {t.rich('source', {
          name: source.name,
          link: (chunks) =>
            href ? (
              <a className={styles.linkBtn} style={INLINE_LINK} href={href} target="_blank" rel="noopener noreferrer">
                {chunks}
              </a>
            ) : (
              <span>{chunks}</span>
            ),
        })}
        {source.sourceFile ? <> · {t('file', { file: source.sourceFile })}</> : null}
        {/* A calendar day, not a moment: shown as that day wherever the reader is. */}
        {asOf ? <> · {t(source.dated === 'imported' ? 'dated.imported' : 'dated.published', { date: format.dateTime(asOf, { dateStyle: 'medium', timeZone: 'UTC' }) })}</> : null}
      </p>
      {source.attribution?.text ? (
        <p className={`${styles.muted} break-words`} data-part="attribution">
          {attributionHref ? (
            <a className={styles.linkBtn} style={INLINE_LINK} href={attributionHref} target="_blank" rel="noopener noreferrer">
              {source.attribution.text}
            </a>
          ) : (
            source.attribution.text
          )}
        </p>
      ) : null}
    </>
  );
}

function FactLine({ fact, t, format }: Words & { fact: SponsorshipFact }) {
  if (fact.kind === 'dol_lca') {
    return (
      <li className="flex flex-col gap-1" data-fact={fact.kind}>
        <p className={styles.body}>{t('fact.dolLca', { count: fact.certifiedCount, year: String(fact.fiscalYear) })}</p>
        <SourceLine source={fact.source} listedAs={null} t={t} format={format} />
      </li>
    );
  }
  if (fact.kind === 'uscis_h1b_hub') {
    return (
      <li className="flex flex-col gap-1" data-fact={fact.kind}>
        <p className={styles.body}>{t('fact.uscis', { approvals: fact.approvals, denials: fact.denials, year: String(fact.fiscalYear) })}</p>
        <SourceLine source={fact.source} listedAs={fact.employerName || null} t={t} format={format} />
      </li>
    );
  }
  const details = [
    fact.rating ? t('fact.ukRating', { rating: fact.rating }) : null,
    fact.routes.length ? t('fact.ukRoutes', { count: fact.routes.length, routes: fact.routes.join(', ') }) : null,
    fact.town ? t('fact.ukTown', { town: fact.town }) : null,
  ].filter((line): line is string => !!line);
  return (
    <li className="flex flex-col gap-1" data-fact={fact.kind}>
      <p className={styles.body}>{t('fact.uk')}</p>
      {details.length ? (
        <p className={`${styles.muted} break-words`} data-part="details">
          {details.join(' · ')}
        </p>
      ) : null}
      <SourceLine source={fact.source} listedAs={fact.employerName || null} t={t} format={format} />
    </li>
  );
}

/** The block itself, from an answer (exported for tests and for a caller that already holds the answer). */
export function SponsorshipFactsBlock({ response, companyName }: { response: CompanySponsorshipResponse; companyName: string }) {
  const t = useTranslations('companyFacts.sponsorship');
  const format = useFormatter();
  const facts = response.facts;
  if (!facts.length) return null;
  const title = t('title', { company: companyName });
  const hasUs = facts.some((f) => f.kind !== 'uk_sponsor_register');
  const { shown, earlier } = splitFacts(facts);
  const body = (
    <>
      <p className={styles.muted}>{t('intro')}</p>
      <ul className={styles.list}>
        {shown.map((fact) => (
          <FactLine key={factKey(fact)} fact={fact} t={t} format={format} />
        ))}
      </ul>
      {earlier.length ? (
        <details data-part="earlier">
          <summary className={SUMMARY}>{t('earlier', { count: earlier.length })}</summary>
          <ul className={styles.list}>
            {earlier.map((fact) => (
              <FactLine key={factKey(fact)} fact={fact} t={t} format={format} />
            ))}
          </ul>
        </details>
      ) : null}
      {hasUs ? <p className={styles.muted}>{t('usNote')}</p> : null}
      <p className={styles.hint} role="note" data-part="disclaimer">
        {t('disclaimer')}
      </p>
    </>
  );
  if (response.viewerNeedsSponsorship) {
    return (
      <section className={styles.section} data-testid="sponsorship-facts" data-open="true" aria-label={title}>
        <h3 className={styles.subTitle}>{title}</h3>
        {body}
      </section>
    );
  }
  return (
    <section className={styles.section} data-testid="sponsorship-facts" data-open="false" aria-label={title}>
      <details>
        <summary className={SUMMARY}>{title}</summary>
        <div className={styles.main}>{body}</div>
      </details>
    </section>
  );
}

export function SponsorshipFacts({ companyId, companyName, jobId }: SponsorshipFactsProps) {
  const enabled = useFlag('h1bHistory') && !!companyId;
  const query = useQuery<CompanySponsorshipResponse>({
    queryKey: companySponsorshipKey(companyId ?? '', jobId),
    queryFn: ({ signal }) => getCompanySponsorship(companyId!, { jobId }, { signal }),
    enabled,
    // The records change when the owner imports a new file, not while a page is open.
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
  if (!enabled || !query.data || !Array.isArray(query.data.facts)) return null;
  return <SponsorshipFactsBlock response={query.data} companyName={companyName} />;
}
