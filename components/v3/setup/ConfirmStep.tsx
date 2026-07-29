'use client';

// ConfirmStep — step 2 of 2. "Here is what your resume says."
//
// This is the whole design in one screen: CONFIRMATION, NOT INTERROGATION.
// The flow it replaces asked seven topics in sequence — target roles, work
// mode, pay, industry, employment type, location, level — one LLM round trip
// each, 12 to 16 seconds apiece when nothing went wrong, while the bootstrap
// read the parsed resume only to build display rows and then wrote an empty
// draft. Here every field arrives PREFILLED from that same parsed resume and
// the user's job is to glance and correct. A correct chip costs a one-second
// look; a wrong one costs one tap.
//
// Zero mandatory typing. One free-text line. One button, never disabled.
//
// ─── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
//
//   • No pay question. `salaryMin` is applied as `salaryMax >= min`, and a
//     Prisma `gte` does not match NULL, so a stated floor deletes every posting
//     without a published range — most of them, and senior postings most of
//     all. The failure is invisible: the user never sees what was removed.
//   • No level picker. Title inflation swings a full band between a 20-person
//     startup and a bank, and candidates self-report about one level high.
//   • No "Direction" control. It shipped as three pills that rewrote the title
//     chips through a role ladder, and its wired effect ran BACKWARDS: `q` is
//     split on whitespace and ORed across title / company / description, so a
//     ladder-widened title ("Staff Software Engineer") matches MORE rows than
//     the one it replaced, not more senior ones. A control whose visible effect
//     is the opposite of its label is worse than no control.
//   • No job cards. /jobs renders those one second later; showing them here is
//     the destination rendered twice.

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { IngestRecap } from './IngestRecap';
import { EditableChipGroup, TogglePillGroup, type ChipOption } from './EditableChipGroup';
import type {
  IngestRow,
  OnboardingSeedSource,
  OnboardingSetupState,
  RAEmploymentType,
  RAWorkType,
} from '../../../lib/api/v2/types';
import type { SetupDraftAction, SetupDraftState } from '../../../hooks/useSetup';

/**
 * Where the sticky action bar has to stop so it does not stick UNDERNEATH the
 * fixed MobileNav — which would hide the only button on the screen, and is
 * worse than not sticking at all.
 *
 * `components/v3/shell/MobileNav.tsx` is `fixed inset-x-0 bottom-0 z-30`, below
 * 760px only, and its height is a 44px tab floor plus 8px of top padding, a 1px
 * rule, and the iOS home indicator twice over (the tab pads for it and
 * `.robo-bottom-nav` pads for it again). Hence `--control-lg + --sp-3 + 2×env`.
 */
const MOBILE_NAV_CLEARANCE =
  'calc(var(--control-lg) + var(--sp-3) + 2 * env(safe-area-inset-bottom, 0px))';

/** The breakpoint `styles/v3.css` shows the MobileNav at. */
const MOBILE_NAV_QUERY = '(max-width: 760px)';

/** 0 on desktop, the nav's height on a phone. A media query cannot be written
 *  in an inline style and this bar is the only thing in the panel that needs
 *  one, so it is read once here rather than added to a shared stylesheet.
 *
 *  KNOWN LIMIT, measured in a browser, not assumed: below 760px the bar does
 *  not stick at all, and no value here changes that. `styles/v3.css` gives
 *  `.main` `overflow-y: auto`, which makes it the sticky SCROLLPORT — and the
 *  same file collapses `.app` to `height: auto` below 760px, so `.main` grows
 *  with its content and never scrolls. A sticky box whose scrollport does not
 *  scroll never leaves the flow. The fix is one line in the shell, not here:
 *  `.main` needs a scrolling box (or the document needs to be the scrollport)
 *  at that width. This offset is already correct for when that lands, and it
 *  costs nothing until then. */
function useStickyBottom(): string {
  const [bottom, setBottom] = useState('0px');
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_NAV_QUERY);
    const apply = () => setBottom(mq.matches ? MOBILE_NAV_CLEARANCE : '0px');
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return bottom;
}

const WORK_MODES: RAWorkType[] = ['remote', 'hybrid', 'onsite'];
const EMPLOYMENT_TYPES: RAEmploymentType[] = [
  'full_time',
  'contract',
  'part_time',
  'internship',
];

/**
 * Role suggestions for a THIN resume — one where neither the deterministic
 * seed nor the model could name a single job title.
 *
 * Best-effort and explicitly labelled as a suggestion, never as a value: the
 * tokens come from the skills and education rows the server already extracted,
 * which is the only signal a resume this thin carries. The user with the
 * thinnest resume is the least able to answer an open question, so an empty
 * text field is the most expensive thing we could put here — a tappable list
 * of words that are demonstrably on their own document is cheaper, even when
 * some of them are wrong.
 *
 * Exported for the unit test.
 */
export function weakSignalRoleSuggestions(rows: IngestRow[] | null): string[] {
  if (!rows) return [];
  const out: string[] = [];
  for (const row of rows) {
    if (row.kind !== 'skills' && row.kind !== 'education') continue;
    for (const token of row.value.split(/[·,;]/)) {
      const value = token.trim();
      // Two chars filters out list punctuation; 40 filters out a sentence that
      // happened to contain no separator.
      if (value.length < 2 || value.length > 40) continue;
      if (out.some((v) => v.toLowerCase() === value.toLowerCase())) continue;
      out.push(value);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

interface Props {
  session: OnboardingSetupState;
  draft: SetupDraftState;
  dispatch: (action: SetupDraftAction) => void;
  freeText: string;
  onFreeTextChange: (value: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  submitting: boolean;
  skipping: boolean;
  /** Draft field names the notes line contributed, echoed after submit. */
  notesEcho?: string | null;
  /** A submit failure, as a `jobs.setup.*` key. Rendered INSIDE the action bar:
   *  the bar is sticky, so a message placed after it would be pushed into the
   *  panel's bottom padding — off screen, underneath the bar, at the exact
   *  moment the user needs to read it. */
  errorKey?: string | null;
}

export function ConfirmStep({
  session,
  draft,
  dispatch,
  freeText,
  onFreeTextChange,
  onSubmit,
  onSkip,
  submitting,
  skipping,
  notesEcho,
  errorKey,
}: Props) {
  const t = useTranslations('jobs.setup');
  const stickyBottom = useStickyBottom();

  const meta = session.fieldMeta ?? {};
  const sourceOf = (field: string): OnboardingSeedSource | null =>
    meta[field]?.source ?? null;

  const evidence = session.evidence ?? {};
  const proposed = new Set(session.proposedFields ?? []);

  // ── Control 1 · Job titles ────────────────────────────────────────
  //
  // The decisive field: `targetRoles[0]` becomes the feed's `q`. Suggestions
  // are the roles the resume named that are not currently applied — putting a
  // removed title back is one tap, so removing one is safe to try.
  const roleSuggestions = useMemo<ChipOption[]>(() => {
    const pool = session.thin
      ? weakSignalRoleSuggestions(session.ingestRows)
      : (evidence.roles ?? []);
    return pool
      .filter(
        (role) =>
          !draft.targetRoles.some((v) => v.toLowerCase() === role.toLowerCase()),
      )
      .slice(0, 6)
      .map((role) => ({ id: role, label: role }));
  }, [draft.targetRoles, evidence.roles, session.ingestRows, session.thin]);

  const rolesEvidence =
    !session.thin && (evidence.roles?.length ?? 0) > 0
      ? t('why_roles', { roles: (evidence.roles ?? []).join(', ') })
      : evidence.years
        ? t('why_years', { years: evidence.years })
        : null;

  // ── Control 2 · Where and how ─────────────────────────────────────
  //
  // The city arrives in `proposedFields` — seeded but NOT applied — so it
  // renders as a question ("Still in Berlin?"), never as a stated fact. The
  // resume says where someone HAS worked; it does not say where they want to.
  // Getting this wrong is not a cosmetic error: `location` is a substring
  // match, so a city outside the corpus geography returns zero rows and turns
  // the first result set into "no jobs found".
  const citySuggestions = useMemo<ChipOption[]>(() => {
    const city = evidence.city;
    if (!city) return [];
    if (!proposed.has('locations')) return [];
    if (draft.cities.some((v) => v.toLowerCase() === city.toLowerCase())) return [];
    return [{ id: city, label: t('where_city_suggest', { city }) }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.cities, evidence.city, session.proposedFields]);

  const notesFields = notesEcho ?? null;

  return (
    <div>
      <header style={{ marginBottom: 'var(--sp-4)' }}>
        {/* SetupPanel focuses this on the step change. The card swaps in place,
         *  so without it the element that had focus (the drop zone, the file
         *  the user just picked) is destroyed and focus falls to <body> — the
         *  keyboard user arrives at step 2 with no idea it happened. */}
        <h2
          data-setup-heading
          tabIndex={-1}
          style={{
            outline: 'none',
            fontSize: 'var(--fs-title)',
            fontWeight: 600,
            letterSpacing: 'var(--ls-title)',
            lineHeight: 'var(--lh-title)',
            margin: '0 0 var(--sp-2)',
            color: 'var(--text)',
          }}
        >
          {session.thin ? t('thin_title') : t('confirm_title')}
        </h2>
        <p
          style={{
            fontSize: 'var(--fs-body)',
            color: 'var(--text-2)',
            lineHeight: 'var(--lh-body)',
            margin: 0,
          }}
        >
          {session.thin
            ? t('thin_lead')
            : session.returning
              ? t('confirm_lead_returning')
              : t('confirm_lead')}
        </p>
      </header>

      {/* 1fr : 2fr above ~620px, one column below — no media query needed, so
       *  this ships without touching a shared stylesheet. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-5)' }}>
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <IngestRecap rows={session.ingestRows ?? null} />
        </div>

        <div style={{ flex: '2 1 340px', minWidth: 0 }}>
          <EditableChipGroup
            label={t('fields.targetRoles')}
            values={draft.targetRoles}
            onRemove={(value) =>
              dispatch({ type: 'remove', field: 'targetRoles', value })
            }
            onAdd={(value) => dispatch({ type: 'add', field: 'targetRoles', value })}
            suggestions={roleSuggestions}
            onSelectSuggestion={(value) =>
              dispatch({ type: 'add', field: 'targetRoles', value })
            }
            emptyPrompt={t('empty.targetRoles')}
            evidence={rolesEvidence}
            source={sourceOf('targetRoles')}
          />

          <TogglePillGroup
            label={t('fields.where')}
            options={WORK_MODES.map((mode) => ({
              id: mode,
              label: t(`values.${mode}`),
            }))}
            selected={draft.workModes}
            onToggle={(id) =>
              dispatch({ type: 'toggle', field: 'workModes', value: id as RAWorkType })
            }
            emptyPrompt={t('chip_none')}
          >
            <EditableChipGroup
              label={t('where_add_place')}
              values={draft.cities}
              onRemove={(value) =>
                dispatch({ type: 'remove', field: 'locations', value })
              }
              onAdd={(value) => dispatch({ type: 'add', field: 'locations', value })}
              suggestions={citySuggestions}
              onSelectSuggestion={(value) =>
                dispatch({ type: 'add', field: 'locations', value })
              }
              emptyPrompt={t('empty.where')}
              evidence={
                evidence.city ? t('why_locations', { city: evidence.city }) : null
              }
              /* No provenance marker, deliberately. A place only ever reaches
               * this list by an explicit tap on the suggestion or by being
               * typed, so by the time a chip exists it is the user's own
               * statement — marking it "check this one" would be warning them
               * about their own answer. The evidence line above still says
               * where the suggestion came from. */
              source={null}
            />
          </TogglePillGroup>

          <TogglePillGroup
            label={t('fields.employmentTypes')}
            options={EMPLOYMENT_TYPES.map((type) => ({
              id: type,
              label: t(`values.${type}`),
            }))}
            selected={draft.employmentTypes}
            onToggle={(id) =>
              dispatch({ type: 'toggleEmployment', value: id as RAEmploymentType })
            }
            emptyPrompt={t('empty.employmentTypes')}
            source={sourceOf('employmentTypes')}
          />

          <EditableChipGroup
            label={t('fields.industriesTarget')}
            values={draft.industriesTarget}
            onRemove={(value) =>
              dispatch({ type: 'remove', field: 'industriesTarget', value })
            }
            onAdd={(value) =>
              dispatch({ type: 'add', field: 'industriesTarget', value })
            }
            emptyPrompt={t('empty.industriesTarget')}
            source={sourceOf('industriesTarget')}
          />

          {/* Boosts, never filters. A wish list as a where-clause returns an
           *  empty page on day one, which is the worst possible first result. */}
          <EditableChipGroup
            label={t('fields.targetCompanies')}
            values={draft.targetCompanies}
            onRemove={(value) =>
              dispatch({ type: 'remove', field: 'targetCompanies', value })
            }
            onAdd={(value) =>
              dispatch({ type: 'add', field: 'targetCompanies', value })
            }
            emptyPrompt={t('empty.targetCompanies')}
          />

          {/* The ONE free-text line, and the only LLM call in the confirm
           *  path. Blank costs zero tokens. */}
          <section style={{ marginBottom: 'var(--sp-5)' }}>
            <label
              htmlFor="setup-notes"
              style={{
                display: 'block',
                fontSize: 'var(--fs-body)',
                fontWeight: 600,
                color: 'var(--text)',
                marginBottom: 'var(--sp-2)',
              }}
            >
              {t('notes_label')}
            </label>
            <input
              id="setup-notes"
              type="text"
              value={freeText}
              maxLength={2000}
              onChange={(e) => onFreeTextChange(e.target.value)}
              placeholder={t('notes_placeholder')}
              style={{
                width: '100%',
                border: '1px solid var(--rule)',
                borderRadius: 'var(--r-sm)',
                background: 'var(--surface)',
                color: 'var(--text)',
                padding: 'var(--sp-3)',
                fontFamily: 'inherit',
                fontSize: 'var(--fs-meta)',
                fontWeight: 400,
                minHeight: 'var(--control-lg)',
              }}
            />
            <p
              style={{
                fontSize: 'var(--fs-label)',
                color: 'var(--text-muted)',
                margin: 'var(--sp-2) 0 0',
              }}
            >
              {t('notes_hint')}
            </p>
            {notesFields ? (
              <p
                role="status"
                style={{
                  fontSize: 'var(--fs-meta)',
                  color: 'var(--ok)',
                  margin: 'var(--sp-2) 0 0',
                }}
              >
                {t('notes_added', { fields: notesFields })}
              </p>
            ) : null}
          </section>
        </div>
      </div>

      {/* STICKY.
       *
       *  Six control groups stacked in one column measure ~2,000px, so the only
       *  button on the screen sits about three viewport-heights below the fold.
       *  The whole promise of this step is "accept the prefill with one tap",
       *  and a tap you have to scroll past six groups to find is not one tap.
       *
       *  Honest scope: this works wherever `.main` is the scrolling box, which
       *  today means desktop only — see `useStickyBottom` for why the phone
       *  case needs a one-line change in the shell that is not this file's to
       *  make. Where it does not engage it degrades to exactly the in-flow
       *  footer that shipped, so it is a win or a no-op and never a regression.
       *
       *  The negative inline margins pull the bar out to the panel's padding
       *  box so content scrolls under it rather than beside it. */}
      <footer
        style={{
          position: 'sticky',
          bottom: stickyBottom,
          zIndex: 1,
          background: 'var(--surface)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-3)',
          flexWrap: 'wrap',
          borderTop: '1px solid var(--rule)',
          marginTop: 'var(--sp-2)',
          marginInline: 'calc(-1 * var(--sp-5))',
          paddingTop: 'var(--sp-4)',
          paddingInline: 'var(--sp-5)',
          paddingBottom: 'var(--sp-4)',
        }}
      >
        {errorKey ? (
          <p
            role="alert"
            style={{
              flexBasis: '100%',
              margin: 0,
              color: 'var(--warn)',
              fontSize: 'var(--fs-meta)',
              lineHeight: 'var(--lh-meta)',
            }}
          >
            {t(errorKey)}
          </p>
        ) : null}

        {/* Never disabled. Touching nothing and pressing this accepts the
         *  prefill, which is why there is no separate "accept" affordance. */}
        <button
          type="button"
          className="btn primary"
          style={{ minHeight: 'var(--control-lg)' }}
          onClick={onSubmit}
          aria-busy={submitting}
        >
          {submitting ? t('submitting') : t('submit')}
        </button>
        <div>
          <button
            type="button"
            className="btn ghost"
            style={{ minHeight: 'var(--control-lg)' }}
            onClick={onSkip}
            disabled={skipping}
          >
            {t('skip')}
          </button>
          <p
            style={{
              fontSize: 'var(--fs-label)',
              color: 'var(--text-muted)',
              margin: 'var(--sp-1) 0 0',
            }}
          >
            {t('skip_note')}
          </p>
        </div>
      </footer>
    </div>
  );
}
