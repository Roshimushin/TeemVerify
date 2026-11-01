# Admitted sources

The public list of outlets TeemVerify looks to first when it checks a claim. This is the
"source admission" gate from the Fact Library Rules: every outlet here meets a written
criterion, applied the same way to all of them, never chosen for where it leans. The list the
checker actually uses is in `supabase/functions/verify-api/sources.ts`; keep the two in step.

Being admitted is not a verdict. A fact-checker's ruling stays a **Tier 2 conclusion**, and news
reporting is a **secondary source**. Research always follows both to the primary record
(documents, data, official statements, recordings), and grades from that. Other outlets can
still be used; primary records count wherever they're published.

Last reviewed: 2026-11-01.

## Fact-checkers

**Criterion:** a verified signatory of the
[IFCN Code of Principles](https://ifcncodeofprinciples.poynter.org/signatories), active or in
renewal. Every signatory qualifies (136 active and 47 in renewal on 2026-11-01). Listed here are
the ones that publish in English or cover the US and UK:

| Outlet | Country | IFCN status (2026-11-01) |
| --- | --- | --- |
| AP Fact Check | United States | Active |
| Reuters Fact Check | United States | Active |
| PolitiFact | United States | Active |
| FactCheck.org | United States | Active |
| Snopes | United States | Active |
| Lead Stories | United States | Active |
| The Washington Post Fact Checker | United States | Active |
| MediaWise | United States | Active |
| Wisconsin Watch | United States | Active |
| The Dispatch Fact Check | United States | In renewal |
| El Detector (Univision) | United States | Active |
| T Verifica (Telemundo) | United States | Active |
| Factchequeado | United States | Active |
| Full Fact | United Kingdom | Active |
| FactCheckNI | United Kingdom | Active |
| PA Media | United Kingdom | In renewal |
| AFP Fact Check | France | Active |
| Deutsche Welle | Germany | Active |
| AAP FactCheck | Australia | Active |
| The Canadian Press | Canada | In renewal |
| The Journal FactCheck | Ireland | Active |
| Africa Check | South Africa | Active |
| Rappler | Philippines | Active |

Not on the IFCN list as active or in renewal on 2026-11-01, so not admitted under this
criterion: USA Today, Check Your Fact.

## Original reporting

**Criterion:** a news organization that does its own original reporting and publishes its
editorial standards and a public corrections process. Its reporting can be evidence for what its
reporters saw or the documents they obtained.

| Outlet | Standards | Corrections |
| --- | --- | --- |
| Associated Press (AP) | Statement of News Values and Principles | Public corrections; AP Fact Check follows AP's correction policy |
| Reuters | Trust Principles; Handbook of Journalism (public) | Handbook rules for corrected, refiled and withdrawn stories |
| Agence France-Presse (AFP) | Editorial Standards and Best Practices | Corrections noted on the item; AFP Factuel corrections page |
| BBC News | BBC Editorial Guidelines (2025) | Corrections and Clarifications page |

These were confirmed through secondary sources on 2026-11-01; the official pages are still to be
linked.

## Changing this list

Add or remove an outlet only by the criteria above, and note the date and reason in the change.
A criterion itself can change, but the new one must apply to every outlet the same way.

## Seed import

Fact-checks are collected into the library only where the outlet's terms allow it. Each one is
stored as a Tier 2 draft with the fact-check as its exhibit, then queued for research to the
primary record. Research pulls evenly across outlets: the queue alternates between them, newest
first, however many each one published.

| Route | Status (2026-11-01) |
| --- | --- |
| [Data Commons fact-check feed](https://datacommons.org/factcheck/download) | Imported: 635 English fact-checks since 2025 by admitted outlets (PolitiFact 251, FactCheck.org 187, Deutsche Welle 180, The Journal 9, The Washington Post 6, The Dispatch 2). Licensed CC BY 4.0; attribution: Data Commons, and each fact-check's outlet, linked on every claim. |
| Google Fact Check Tools API | Used live during research only. Google's API terms (section 5e) forbid storing its results as a database, so nothing from it is saved except links Claude opens and cites. |
| Outlets' own pages | Only with each outlet's permission. FactCheck.org allows free reuse with credit and a link (and is already in the feed). Full Fact allows reuse under its own API licence. Snopes blocks Anthropic's crawlers in robots.txt, so it isn't collected. PolitiFact, AP, Reuters and Lead Stories: terms not yet confirmed. |
