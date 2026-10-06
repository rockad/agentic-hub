#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["numpy>=1.24"]
# ///
"""Tests for the verification pass: five kinds of uncertainty, one block.

Everything here runs on made-up `Utterance` lists and plain scores — no
audio, no model — the same split `naming_test.py` and `voices_test.py` use
for their own pure decisions. `evals/smoke.sh` covers the two facts a unit
test cannot: a real transcription with nothing uncertain writes no block at
all, and one with a genuinely unresolvable speaker writes one.

    uv run --script evals/verify_test.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from lt.label import Utterance  # noqa: E402
from lt.naming import UnresolvedSpeaker  # noqa: E402
from lt.voices import SpeakerMatch  # noqa: E402
from lt import verify  # noqa: E402


def u(start: float, speaker: str | None, text: str, duration: float = 1.0) -> Utterance:
    return Utterance(start, start + duration, speaker, text)


class TestLowConfidenceIdentifications(unittest.TestCase):
    def test_a_match_below_the_line_is_flagged_with_its_evidence(self):
        matches = [SpeakerMatch(speaker="Ada Lovelace", similarity=0.72)]
        utterances = [
            u(0, "Ada Lovelace", "yeah"),
            u(1, "Ada Lovelace", "so I think we should ship this week"),
        ]
        found = verify.low_confidence_identifications(matches, utterances)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].speaker, "Ada Lovelace")
        self.assertEqual(found[0].similarity, 0.72)
        self.assertEqual(found[0].first_utterance, "so I think we should ship this week")

    def test_a_confident_match_is_not_flagged(self):
        matches = [SpeakerMatch(speaker="Ada Lovelace", similarity=0.91)]
        found = verify.low_confidence_identifications(matches, [u(0, "Ada Lovelace", "hi")])
        self.assertEqual(found, [])

    def test_exactly_at_the_line_is_not_flagged(self):
        matches = [SpeakerMatch(speaker="Ada Lovelace", similarity=verify.LOW_CONFIDENCE_BELOW)]
        found = verify.low_confidence_identifications(matches, [u(0, "Ada Lovelace", "hi")])
        self.assertEqual(found, [])

    def test_no_matches_is_quiet(self):
        self.assertEqual(verify.low_confidence_identifications([], [u(0, "Ada Lovelace", "hi")]), [])

    def test_a_speaker_with_no_utterances_still_returns_something(self):
        # Should not be reachable in practice, but must not crash the pass.
        matches = [SpeakerMatch(speaker="Nobody Here", similarity=0.6)]
        found = verify.low_confidence_identifications(matches, [])
        self.assertEqual(found[0].first_utterance, "")

    def test_multiple_low_matches_are_sorted_weakest_first(self):
        matches = [
            SpeakerMatch(speaker="Ada Lovelace", similarity=0.78),
            SpeakerMatch(speaker="Alan Turing", similarity=0.60),
        ]
        found = verify.low_confidence_identifications(
            matches, [u(0, "Ada Lovelace", "hi there"), u(1, "Alan Turing", "hi there too")]
        )
        self.assertEqual([m.speaker for m in found], ["Alan Turing", "Ada Lovelace"])


class TestUnattributedGroup(unittest.TestCase):
    def test_no_unattributed_turns_returns_none(self):
        utterances = [u(0, "Ada Lovelace", "hi"), u(1, "Alan Turing", "hi back")]
        self.assertIsNone(verify.unattributed_group(utterances))

    def test_unattributed_turns_are_grouped_not_listed(self):
        utterances = [
            u(0, "Ada Lovelace", "let's start"),
            u(2, None, "mm"),
            u(4, None, "uh huh", duration=2.0),
            u(8, "Ada Lovelace", "moving on"),
        ]
        group = verify.unattributed_group(utterances)
        self.assertIsNotNone(group)
        self.assertEqual(group.count, 2)
        self.assertEqual(group.total_seconds, 1.0 + 2.0)
        self.assertEqual(group.sample_timestamps, ["00:00:02", "00:00:04"])

    def test_the_timestamp_sample_is_capped(self):
        utterances = [u(i * 10, None, "mm") for i in range(10)]
        group = verify.unattributed_group(utterances)
        self.assertEqual(len(group.sample_timestamps), verify.UNATTRIBUTED_SAMPLE)
        self.assertEqual(group.count, 10)


class TestSuspectedManglings(unittest.TestCase):
    def test_an_irregular_internal_capital_is_flagged(self):
        # The real shape this catches: two leading capitals, then lowercase —
        # the invented stand-in for "QBornets" in this plugin's own examples.
        utterances = [u(0, "Speaker 1", "we moved everything onto QBornets last week")]
        found = verify.suspected_manglings(utterances)
        self.assertEqual([m.token for m in found], ["QBornets"])
        self.assertEqual(found[0].count, 1)
        self.assertIn("QBornets", found[0].first_context)

    def test_a_lowercase_to_uppercase_transition_is_flagged(self):
        utterances = [u(0, "Speaker 1", "check the boRnets cluster config")]
        found = verify.suspected_manglings(utterances)
        self.assertEqual([m.token for m in found], ["boRnets"])

    def test_an_ordinary_capitalised_word_is_not_flagged(self):
        utterances = [u(0, "Speaker 1", "Grace introduced the roadmap for Kubernetes")]
        self.assertEqual(verify.suspected_manglings(utterances), [])

    def test_a_plain_lowercase_word_is_not_flagged(self):
        utterances = [u(0, "Speaker 1", "we discussed the database migration plan")]
        self.assertEqual(verify.suspected_manglings(utterances), [])

    def test_a_pure_acronym_is_not_flagged(self):
        # All-caps has no lowercase run after it, so it does not match the
        # irregular-capital shape at all — acronyms are the casing pass's job.
        utterances = [u(0, "Speaker 1", "we moved it onto NASA infrastructure")]
        self.assertEqual(verify.suspected_manglings(utterances), [])

    def test_a_hyphenated_acronym_word_splice_is_deliberately_not_caught(self):
        # CR-adress-shaped: documented in the module as a deliberate miss,
        # because the same shape is an ordinary compound like "US-based".
        utterances = [u(0, "Speaker 1", "please file a CR-adress for this")]
        self.assertEqual(verify.suspected_manglings(utterances), [])

    def test_a_token_repeated_too_often_is_not_flagged(self):
        text = "QBornets is great, we run everything on QBornets, QBornets scales fine"
        utterances = [u(0, "Speaker 1", text)]
        self.assertEqual(verify.suspected_manglings(utterances), [])

    def test_a_known_term_is_excluded(self):
        utterances = [u(0, "Speaker 1", "we run this on QBornets")]
        found = verify.suspected_manglings(utterances, known_terms={"QBornets"})
        self.assertEqual(found, [])

    def test_a_known_term_is_excluded_case_insensitively(self):
        utterances = [u(0, "Speaker 1", "we run this on QBornets")]
        found = verify.suspected_manglings(utterances, known_terms={"qbornets"})
        self.assertEqual(found, [])

    def test_a_short_token_is_not_flagged(self):
        utterances = [u(0, "Speaker 1", "oK that works for me")]
        self.assertEqual(verify.suspected_manglings(utterances), [])

    def test_cyrillic_text_never_produces_a_mangling(self):
        # The module docstring's own guarantee: this only ever tokenises
        # Latin script, so a Cyrillic-rendered Latin name is structurally
        # never attempted here, however "irregular" it might look.
        utterances = [
            u(0, "Speaker 1", "мы обсуждаем кластер и хранилище объектов ещё раз")
        ]
        self.assertEqual(verify.suspected_manglings(utterances), [])

    def test_results_are_capped(self):
        utterances = [
            u(i, "Speaker 1", f"we tried QBor{i}nets today") for i in range(verify.MAX_MANGLINGS + 5)
        ]
        found = verify.suspected_manglings(utterances)
        self.assertLessEqual(len(found), verify.MAX_MANGLINGS)


class TestCasingVariants(unittest.TestCase):
    def test_two_casings_of_a_two_word_term_are_grouped(self):
        # Each mention sits mid-sentence, deliberately — a mention at the very
        # start of a sentence is excluded on purpose (see the sentence-initial
        # test below), so a fixture for this test must not accidentally rely
        # on one to reach the minimum count.
        utterances = [
            u(0, "Speaker 1", "we use object storage for backups"),
            u(1, "Speaker 1", "let's move to Object Storage this quarter"),
            u(2, "Speaker 1", "we should also use Object Storage for archives"),
        ]
        found = verify.casing_variants(utterances)
        self.assertEqual(len(found), 1)
        variants = dict(found[0].variants)
        self.assertEqual(variants["Object Storage"], 2)
        self.assertEqual(variants["object storage"], 1)

    def test_a_single_word_acronym_case_split_is_caught(self):
        utterances = [
            u(0, "Speaker 1", "the VPC is ready"),
            u(1, "Speaker 1", "check the VPC settings"),
            u(2, "Speaker 1", "we finalised the vpc yesterday"),
        ]
        found = verify.casing_variants(utterances)
        self.assertEqual(len(found), 1)
        variants = dict(found[0].variants)
        self.assertEqual(variants["VPC"], 2)
        self.assertEqual(variants["vpc"], 1)

    def test_a_single_consistent_casing_is_not_flagged(self):
        utterances = [
            u(0, "Speaker 1", "we use Object Storage for backups"),
            u(1, "Speaker 1", "Object Storage is cheaper"),
            u(2, "Speaker 1", "Object Storage scales well too"),
        ]
        self.assertEqual(verify.casing_variants(utterances), [])

    def test_below_the_minimum_total_is_not_flagged(self):
        # Only two total mentions — one of each casing — below CASING_MIN_TOTAL.
        utterances = [
            u(0, "Speaker 1", "we use object storage here"),
            u(1, "Speaker 1", "and also Object Storage there"),
        ]
        self.assertEqual(verify.casing_variants(utterances), [])

    def test_sentence_initial_capitalisation_is_not_mistaken_for_a_variant(self):
        # "The project" at the start of a sentence, and "the project" mid
        # sentence elsewhere, differ only because of ordinary English
        # capitalisation — never a spelling inconsistency worth asking about.
        utterances = [
            u(0, "Speaker 1", "The project is going well. The project ships next week."),
            u(1, "Speaker 1", "we discussed the project timeline earlier today"),
            u(2, "Speaker 1", "and the project budget as well, at length"),
        ]
        self.assertEqual(verify.casing_variants(utterances), [])

    def test_a_phrase_of_pure_stopwords_is_never_flagged(self):
        utterances = [
            u(0, "Speaker 1", "we said that we would do it and then we did it"),
            u(1, "Speaker 1", "So That We Would Do It later that day as planned"),
        ]
        self.assertEqual(verify.casing_variants(utterances), [])

    def test_results_are_capped_and_sorted_by_total_count(self):
        utterances = []
        for i in range(verify.MAX_CASING_GROUPS + 3):
            term = f"widgetname{i}"
            utterances.append(u(i * 2, "Speaker 1", f"we ship the {term} today"))
            utterances.append(u(i * 2 + 1, "Speaker 1", f"the {term.capitalize()} shipped fine"))
            utterances.append(u(i * 2 + 100, "Speaker 1", f"more on {term} tomorrow"))
        found = verify.casing_variants(utterances)
        self.assertLessEqual(len(found), verify.MAX_CASING_GROUPS)


class TestVerificationBlock(unittest.TestCase):
    def test_an_empty_block_is_empty(self):
        self.assertTrue(verify.VerificationBlock().is_empty())

    def test_any_single_category_makes_it_non_empty(self):
        block = verify.VerificationBlock(
            manglings=[verify.SuspectedMangling("QBornets", 1, "text", 0.0)]
        )
        self.assertFalse(block.is_empty())


class TestBuild(unittest.TestCase):
    def test_a_dictation_style_run_never_reports_speaker_findings(self):
        # Every utterance carries speaker=None by construction on a dictated
        # file — this must never be read as "the diarizer failed here".
        utterances = [u(0, None, "just me talking today")]
        block = verify.build(utterances, is_diarized=False)
        self.assertIsNone(block.unattributed)
        self.assertEqual(block.low_confidence, [])
        self.assertEqual(block.unresolved_speakers, [])

    def test_a_dictation_style_run_still_checks_the_text(self):
        utterances = [u(0, None, "we moved everything onto QBornets today")]
        block = verify.build(utterances, is_diarized=False)
        self.assertEqual([m.token for m in block.manglings], ["QBornets"])

    def test_a_diarized_run_reports_unattributed_and_unresolved(self):
        unresolved = [
            UnresolvedSpeaker(
                speaker="Speaker 2", first_utterance="hi", turns=1,
                word_share=0.1, candidates=["Ada Lovelace"],
            )
        ]
        utterances = [u(0, "Speaker 1", "hi"), u(1, None, "mm")]
        block = verify.build(utterances, is_diarized=True, unresolved=unresolved)
        self.assertEqual(len(block.unresolved_speakers), 1)
        self.assertIsNotNone(block.unattributed)

    def test_a_clean_diarized_run_is_empty(self):
        utterances = [
            u(0, "Ada Lovelace", "let's get started with the roadmap"),
            u(1, "Alan Turing", "sounds good, I have a few questions"),
        ]
        block = verify.build(utterances, is_diarized=True)
        self.assertTrue(block.is_empty())


class TestRender(unittest.TestCase):
    def test_an_empty_block_renders_nothing(self):
        self.assertEqual(verify.render(verify.VerificationBlock()), "")

    def test_the_heading_and_note_are_present_when_anything_fires(self):
        block = verify.VerificationBlock(
            manglings=[verify.SuspectedMangling("QBornets", 1, "we run QBornets", 12.0)]
        )
        rendered = verify.render(block)
        self.assertIn("## Needs a quick look", rendered)
        self.assertIn("One short reply", rendered)
        self.assertIn("QBornets", rendered)

    def test_unresolved_speakers_are_nested_as_a_subsection(self):
        unresolved = [
            UnresolvedSpeaker(
                speaker="Speaker 2", first_utterance="so where were we",
                turns=5, word_share=0.3, candidates=["Ada Lovelace"],
            )
        ]
        block = verify.VerificationBlock(unresolved_speakers=unresolved)
        rendered = verify.render(block)
        self.assertIn("### Unresolved speakers", rendered)
        # A leading "\n" pins this to a line that is *exactly* the old H2
        # heading — "### Unresolved speakers" also contains "## Unresolved
        # speakers" as a bare substring, which would make a naive check here
        # pass even if the heading were wrongly left at the top level.
        self.assertNotIn("\n## Unresolved speakers\n", rendered)
        self.assertIn("Ada Lovelace", rendered)

    def test_names_file_is_named_when_given(self):
        block = verify.VerificationBlock(
            casing=[verify.CasingGroup(variants=[("Object Storage", 3), ("object storage", 2)])]
        )
        rendered = verify.render(block, names_file=Path("colleagues.txt"))
        self.assertIn("colleagues.txt", rendered)

    def test_a_suggestion_is_made_when_no_names_file_was_given(self):
        block = verify.VerificationBlock(
            casing=[verify.CasingGroup(variants=[("Object Storage", 3), ("object storage", 2)])]
        )
        rendered = verify.render(block, names_file=None)
        self.assertIn("--names-file", rendered)

    def test_low_confidence_section_names_the_threshold(self):
        block = verify.VerificationBlock(
            low_confidence=[verify.LowConfidenceMatch("Ada Lovelace", 0.72, "so I think")]
        )
        rendered = verify.render(block)
        self.assertIn("Low-confidence", rendered)
        self.assertIn("0.72", rendered)

    def test_unattributed_section_reports_a_group_not_a_list(self):
        block = verify.VerificationBlock(
            unattributed=verify.UnattributedGroup(count=4, total_seconds=12.0, sample_timestamps=["00:00:02", "00:00:09"])
        )
        rendered = verify.render(block)
        self.assertIn("Unattributed speech", rendered)
        self.assertIn("4 turn(s)", rendered)
        self.assertIn("00:00:02", rendered)


class TestSummarize(unittest.TestCase):
    def test_an_empty_block_summarizes_to_nothing(self):
        self.assertEqual(verify.summarize(verify.VerificationBlock()), "")

    def test_a_non_empty_block_is_one_compact_message(self):
        block = verify.VerificationBlock(
            manglings=[verify.SuspectedMangling("QBornets", 1, "we run QBornets", 12.0)],
            casing=[verify.CasingGroup(variants=[("VPC", 2), ("vpc", 1)])],
        )
        summary = verify.summarize(block)
        self.assertIn("needs a quick look", summary)
        self.assertIn("QBornets", summary)
        self.assertIn("VPC", summary)

    def test_unresolved_speakers_reuse_naming_summarize_unresolved(self):
        unresolved = [
            UnresolvedSpeaker(
                speaker="Speaker 2", first_utterance="so where were we",
                turns=5, word_share=0.3, candidates=["Ada Lovelace"],
            )
        ]
        block = verify.VerificationBlock(unresolved_speakers=unresolved)
        summary = verify.summarize(block)
        self.assertIn("Speaker 2", summary)
        self.assertIn("Ada Lovelace", summary)
        # The umbrella header appears exactly once, not once per section.
        self.assertEqual(summary.count("needs a quick look"), 1)


class TestAcronymPluralsAreNotManglings(unittest.TestCase):
    """0.11.1 (a). `^[A-Z]{2,}[a-z]` matches an acronym carrying a plural
    `s`, so `GPUs` and `LLMs` were reported as suspected mis-hearings. On one
    real meeting four of eight findings were this single shape."""

    def test_a_plural_acronym_is_not_a_mangling(self):
        utterances = [
            u(0, "Speaker 1", "the GPUs are saturated and the LLMs keep timing out"),
            u(1, "Speaker 1", "we have IBEs on bare metal and SVNs in the old racks"),
        ]
        self.assertEqual(verify.suspected_manglings(utterances), [])

    def test_a_possessive_acronym_is_not_a_mangling(self):
        utterances = [u(0, "Speaker 1", "the GPU's memory is the constraint")]
        self.assertEqual(verify.suspected_manglings(utterances), [])

    def test_a_real_mangling_that_merely_ends_in_s_still_flags(self):
        # The suppression keys on the stem being all capitals, not on the
        # trailing `s` — otherwise it would swallow the very shape the
        # detector exists for.
        utterances = [u(0, "Speaker 1", "we moved everything onto QBornets last week")]
        self.assertEqual([m.token for m in verify.suspected_manglings(utterances)], ["QBornets"])

    def test_a_plural_of_a_known_term_is_not_a_mangling(self):
        utterances = [u(0, "Speaker 1", "both boRnets clusters are up")]
        found = verify.suspected_manglings(utterances, known_terms={"boRnet"})
        self.assertEqual(found, [])


class TestCasingCollapsesToOneTokenPerQuestion(unittest.TestCase):
    """0.11.1 (b). Overlapping n-grams reported one inconsistent word once
    per phrase it appeared in: a real meeting asked about "because I", "I
    mean" and "I already" as three findings, all of them the word `I`."""

    def test_phrases_varying_in_the_same_single_word_become_one_finding(self):
        utterances = [
            u(0, "Speaker 1", "So because I said it. So because I meant it. So because I did."),
            u(1, "Speaker 1", "So because i said it. So because i meant it."),
            u(2, "Speaker 1", "Well I mean that. Well I mean this. Well I mean so."),
            u(3, "Speaker 1", "Well i mean that. Well i mean this."),
        ]
        groups = verify.casing_variants(utterances)
        self.assertEqual(len(groups), 1)
        self.assertGreaterEqual(groups[0].folded, 1)
        # The survivor is the most-evidenced phrasing, not an arbitrary one.
        self.assertGreaterEqual(
            sum(count for _, count in groups[0].variants), verify.CASING_MIN_TOTAL
        )

    def test_phrases_varying_in_different_words_stay_separate(self):
        utterances = [
            u(0, "Speaker 1", "We use Object Storage here. We use Object Storage there."),
            u(1, "Speaker 1", "We use Object storage here."),
            u(2, "Speaker 1", "The Managed Service shipped. The Managed Service works."),
            u(3, "Speaker 1", "The managed Service shipped."),
        ]
        groups = verify.casing_variants(utterances)
        self.assertGreaterEqual(len(groups), 2)

    def test_the_fold_count_is_reported_in_the_block(self):
        group = verify.CasingGroup(variants=[("because I", 8), ("because i", 2)], folded=2)
        block = verify.VerificationBlock(casing=[group])
        rendered = verify.render(block)
        self.assertIn("2 other phrase(s) differing only in this word", rendered)


class TestManglingsQuoteEachTurnOnce(unittest.TestCase):
    """0.11.1 (c). Each suspect token quoted its whole turn, so one long
    sentence carrying three of them appeared three times in one block."""

    def test_three_tokens_in_one_turn_quote_that_turn_once(self):
        context = "we put devX and OpenBow behind GitHub's runner"
        block = verify.VerificationBlock(
            manglings=[
                verify.SuspectedMangling(token="devX", count=1, first_context=context, at=342.0),
                verify.SuspectedMangling(token="OpenBow", count=1, first_context=context, at=342.0),
                verify.SuspectedMangling(token="GitHubs", count=1, first_context=context, at=342.0),
            ]
        )
        rendered = verify.render(block)
        self.assertEqual(rendered.count(f"> {context}"), 1)
        for token in ("devX", "OpenBow", "GitHubs"):
            self.assertIn(f"**{token}**", rendered)
        # One timestamp line for the turn, not one per token.
        self.assertEqual(rendered.count("at 00:05:42"), 1)

    def test_tokens_in_different_turns_still_quote_both(self):
        block = verify.VerificationBlock(
            manglings=[
                verify.SuspectedMangling(token="devX", count=1, first_context="first turn", at=1.0),
                verify.SuspectedMangling(token="OpenBow", count=1, first_context="second turn", at=9.0),
            ]
        )
        rendered = verify.render(block)
        self.assertIn("> first turn", rendered)
        self.assertIn("> second turn", rendered)


if __name__ == "__main__":
    unittest.main(verbosity=2)
