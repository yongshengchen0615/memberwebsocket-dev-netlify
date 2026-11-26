# Admin Calendar Navigation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement the tasks in this session.

**Goal:** Apply the reference video's month/day navigation and create menu to the three admin calendars.

**Architecture:** Add `admin/calendar-navigation.js` and CSS, consuming current authorized in-memory rows and existing editor callbacks. Keep API, schema, notification, and business rules unchanged.

**Tech Stack:** Existing plain JavaScript, CSS, Node tests, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-11-26-admin-calendar-navigation-design.md`.

## Global Constraints

- Base/target `Integrated-Marketing-Platform`; Supabase `bmwhojszsnxliekkhrka` only.
- No new dependency, DB migration, external call or timer for calendar navigation.
- Keep each scope isolated and use existing editor/save/booking-review flows.
- Full existing CI baseline plus all numbered ACs must run on the delivered version.

## Review Focus

- December/January and leap day arithmetic; invalid dates fail closed.
- Overlapping and overnight bookings remain visible without rewriting their times.
- Vertical scrolling and cancelled gestures never change a date or accidentally open an editor.
- Refresh keeps the active date without duplicating controls/listeners.
- 320px/mobile, theme, keyboard and focus restoration remain usable.

### Task 1: Navigation model and browser contract

Files: new `tests/admin_calendar_navigation.test.js`, new `tests/browser/admin-calendar-navigation.spec.cjs`; modify browser fixture script list.

- [ ] Add literal unit cases for month sequence/date arithmetic and overnight segments; run to observe RED.
- [ ] Add browser cases for month/day navigation, scoped create, refresh, gestures, themes and keyboard; observe RED on baseline.
- [ ] Implement exported `monthSequence(month)`, `shiftDate(date, days)`, `bookingSegment(booking, date)` in `admin/calendar-navigation.js`.

### Task 2: Integrate the three surfaces

Files: new navigation JS/CSS; `admin/app.js`, `admin/index.html`; affected existing browser tests; CI syntax list.

Interface: `MemberAdminCalendarNavigation.connect({grid, scope, month, today, rows, onMonthChange, onCreate, onOpen})`; state belongs to each grid and refresh replaces its data snapshot. Month grid remains produced by existing code.

- [ ] Mount month strip, month picker, month/day switch, day pane and scoped ＋ menu.
- [ ] Wire existing editor callbacks and booking focus handoff; add horizontal pointer gesture with cancellation and keyboard/focus behavior.
- [ ] Render date-only items as all-day and bookings on an hourly timeline; show all overlapping/carry-over entries.
- [ ] Update legacy UI tests to enter the day view before creating; keep persistence, isolation and negative assertions.
- [ ] Run scoped tests until GREEN, inspect screenshots at 320/390/1280px in both themes.

### Task 3: Final verification and reviewable delivery

- [ ] Run runtime-quality before/after, full test workflows and production-mode static build; keep actual counts/logs and blockers.
- [ ] Compare calendar navigation request counts and asset sizes under identical fixture conditions; do not claim unmeasured speed gains.
- [ ] Review final diff, commit/push isolated branch, create PR to `Integrated-Marketing-Platform` with AC evidence and rollback instructions.
- [ ] Verify CI and preview SHA/deploy metadata; no production change.
