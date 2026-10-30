# Booking Calendar Day Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Calendar dates open the member's date-scoped bookings/snapshots and a guarded start action.
**Architecture:** Reuse existing renderers inside a single date dialog, filter authenticated bootstrap data locally. Calendar remains the entry point to the existing selection form.
**Tech Stack:** Static HTML/CSS/JS, Node test, JSDOM, Playwright, existing Supabase and Netlify.
**Spec:** docs/superpowers/specs/2026-10-30-booking-calendar-day-records-design.md

## Global Constraints
No API/schema/auth changes, dependencies, copied actionable cards, or extra date-click requests. Snapshot date uses Asia/Taipei createdAt. Keep all existing CI gates.

## Review Focus
Past and holiday dates remain readable without permitting booking.
Refresh preserves selected-date scope and identity isolation.
Deep links reveal the correct date and status panel.
Snapshot mode keeps calendar accessible.
Mobile dialog scrolling, Escape and focus restoration remain usable.

### Task 1: Date dialog and scoped records
Files: booking/index.html, calendar-flow.js/css, app.js, booking-accessible.js/css under MemberWebsocket-dev; tests/integration/booking_startup.cjs and booking_calendar_day_records.cjs.
Interface: booking:history-date-selected {date}; existing bookings-rendered retains all date/time/status rows for calendar; snapshot-history-rendered notifies the calendar of rendered nodes.
- [ ] Write and run failing DOM checks for date-dialog-first flow, filter, Taipei dates, blocked booking, identity reset and deep links.
- [ ] Move original records into dialog; add date state/filter to original renderers; add guarded start button and history navigation.
- [ ] Run new DOM tests, existing regression, integration, build and browser cases.

### Task 2: Browser acceptance and delivery
Files: tests/browser/booking-calendar-day-records.spec.cjs; CI integration list; evidence/report.
- [ ] Add real Chromium desktop/mobile keyboard, scrolling, selected-date filter and snapshot checks.
- [ ] Run full existing CI baseline on candidate SHA and review diff; record asset-byte comparison and no extra date-click API requests.
- [ ] Create PR with existing template, merge only on full passing gates; verify integrated branch same-SHA CI and Netlify deployment/smoke.
