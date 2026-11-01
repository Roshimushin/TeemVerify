// Admitted outlets: the source-admission gate from the Fact Library Rules. Each outlet is in
// because it meets a written criterion, applied the same way to every outlet; never because of
// where it leans. SOURCES.md is the public, readable copy of this list: change both together.
//
// Being admitted makes an outlet a place to look first and to cross-reference, not a verdict.
// Fact-checker verdicts stay Tier 2 conclusions, and news reporting is a secondary source:
// research still follows both to the primary record.

export const ADMITTED_AS_OF = "2026-11-01";

// Criterion: a verified signatory of the IFCN Code of Principles, active or in renewal
// (ifcncodeofprinciples.poynter.org/signatories). Every signatory qualifies; these are the
// ones that publish in English or cover the US and UK, where Becket reads.
export const FACT_CHECKERS = [
  "AP Fact Check", "Reuters Fact Check", "AFP Fact Check", "PolitiFact", "FactCheck.org",
  "Snopes", "Lead Stories", "The Washington Post Fact Checker", "The Dispatch Fact Check",
  "MediaWise", "Wisconsin Watch", "Full Fact", "FactCheckNI", "PA Media", "AAP FactCheck",
  "The Canadian Press", "The Journal FactCheck", "Deutsche Welle", "Africa Check", "Rappler",
  "El Detector (Univision)", "T Verifica (Telemundo)", "Factchequeado",
];

// Criterion: a news organization doing its own original reporting, with published editorial
// standards and a public corrections process. Their reporting can be an exhibit for what their
// reporters saw or the documents they obtained; for anything else, follow it to the source.
export const ORIGINAL_REPORTING = ["Associated Press (AP)", "Reuters", "Agence France-Presse (AFP)", "BBC News"];

export const CROSS_REFERENCE_RULES = `## Cross-reference before grading
Admitted outlets (as of ${ADMITTED_AS_OF}, chosen by written criteria, not by lean):
- Fact-checkers (verified IFCN signatories): ${FACT_CHECKERS.join(", ")}, and any other verified IFCN signatory.
- Original reporting (published standards and corrections): ${ORIGINAL_REPORTING.join(", ")}.
For each claim:
1. Your first search for every claim is the cross-reference search: the claim's key words plus "fact check". Look in the results for admitted fact-checkers and admitted news organizations. When several fact-checkers covered it, read more than one; don't favor any outlet. If none covered it, say so in the reason ("No admitted fact-checks found").
2. Follow what they cite to the primary record (documents, data, official statements, recordings) and grade from that. A fact-checker's verdict is a Tier 2 conclusion: list the primary records as exhibits, and the fact-check itself (source_type "fact_checker") only when its evidence can't be reached.
3. If admitted outlets disagree with each other or with the primary record, say so in the reason and grade from the primary evidence.
4. Other outlets can be used too; admitted ones are simply where to look first. Primary records count wherever they're published. Never cite a trivia, listicle or content-farm site as an exhibit: find who it got the fact from.
5. Use source_type "fact_checker" only for the admitted fact-checkers above. A site that calls itself a fact-checker but isn't admitted is "secondary" at most, and needs a primary source behind it.`;
