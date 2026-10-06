#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["numpy>=1.24"]
# ///
"""Tests for naming a speaker from context, and the known-names spelling pass.

Everything here runs on made-up `Utterance` lists and plain strings — no
audio, no model, no `sherpa-onnx` — because `resolve_names` and `apply` are
the pure decisions this plugin's naming pass rests on, the same split
`quality_test.py` and `voices_test.py` use for their own pure-function cores.
The real-recording half — whether the ask path actually stays quiet on a real
file — is covered end to end by `evals/smoke.sh`, which builds its own
two-voice recordings and runs `--attendees` against them. Run one of your own
recordings through `--attendees` before trusting the pass in a language these
fixtures do not cover.

    uv run --script evals/naming_test.py
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from lt.label import Utterance  # noqa: E402
from lt import naming, spelling  # noqa: E402


def u(start: float, speaker: str | None, text: str) -> Utterance:
    return Utterance(start, start + 1.0, speaker, text)


class TestParseAttendees(unittest.TestCase):
    def test_splits_and_strips(self):
        self.assertEqual(
            naming.parse_attendees(" Ada Lovelace , Alan Turing "),
            ["Ada Lovelace", "Alan Turing"],
        )

    def test_drops_empties_and_dedupes(self):
        self.assertEqual(naming.parse_attendees("Alice,,Alice,Bob"), ["Alice", "Bob"])

    def test_empty_string_is_no_attendees(self):
        self.assertEqual(naming.parse_attendees(""), [])


class TestEliminationOnOneToOne(unittest.TestCase):
    """The case the task exists for: a 1:1 with one speaker already named."""

    def test_the_only_other_speaker_is_the_only_remaining_attendee(self):
        utterances = [
            u(0, "Grace Hopper", "let's get started"),
            u(1, "Speaker 2", "sounds good to me"),
            u(2, "Grace Hopper", "so first, introductions"),
            u(3, "Speaker 2", "sure, I will start"),
        ]
        result = naming.resolve_names(utterances, ["Grace Hopper", "Edsger Dijkstra"])
        self.assertEqual(len(result.assignments), 1)
        assignment = result.assignments[0]
        self.assertEqual(assignment.speaker, "Speaker 2")
        self.assertEqual(assignment.name, "Edsger Dijkstra")
        self.assertEqual(assignment.basis, "from the attendee list by elimination")
        self.assertEqual([u.speaker for u in utterances], [
            "Grace Hopper", "Edsger Dijkstra", "Grace Hopper", "Edsger Dijkstra",
        ])
        self.assertEqual(result.unresolved, [])

    def test_no_attendees_given_does_nothing(self):
        utterances = [u(0, "Grace Hopper", "hi"), u(1, "Speaker 2", "hi")]
        result = naming.resolve_names(utterances, [])
        self.assertEqual(result.assignments, [])
        self.assertEqual(result.unresolved, [])
        self.assertEqual(utterances[1].speaker, "Speaker 2")

    def test_no_numbered_speakers_left_does_nothing(self):
        # Every speaker was already identified from an enrolled print —
        # nothing for this pass to do, and it must not invent extra work.
        utterances = [u(0, "Grace Hopper", "hi"), u(1, "Edsger Dijkstra", "hi")]
        result = naming.resolve_names(utterances, ["Grace Hopper", "Edsger Dijkstra"])
        self.assertEqual(result.assignments, [])
        self.assertEqual(result.unresolved, [])


class TestEliminationGeneralises(unittest.TestCase):
    """N speakers, N attendees, N-1 already named — the last one follows."""

    def test_three_speakers_two_already_named(self):
        utterances = [
            u(0, "Grace Hopper", "morning both"),
            u(1, "Ada Lovelace", "morning"),
            u(2, "Speaker 3", "hey everyone"),
        ]
        result = naming.resolve_names(
            utterances, ["Grace Hopper", "Ada Lovelace", "Alan Turing"]
        )
        self.assertEqual(
            [(a.speaker, a.name) for a in result.assignments],
            [("Speaker 3", "Alan Turing")],
        )
        self.assertEqual(result.unresolved, [])


class TestMissingAttendeeStaysUnresolved(unittest.TestCase):
    """An attendee list with a name missing is not license to guess."""

    def test_one_speaker_left_with_no_candidates_is_reported_not_guessed(self):
        utterances = [
            u(0, "Grace Hopper", "let's get started"),
            u(1, "Speaker 2", "sounds good"),
        ]
        # The attendee list is missing the second person entirely.
        result = naming.resolve_names(utterances, ["Grace Hopper"])
        self.assertEqual(result.assignments, [])
        self.assertEqual(len(result.unresolved), 1)
        unresolved = result.unresolved[0]
        self.assertEqual(unresolved.speaker, "Speaker 2")
        self.assertEqual(unresolved.candidates, [])
        self.assertEqual(utterances[1].speaker, "Speaker 2")


class TestThreeSpeakersNeitherEliminationNorWordsCanSettle(unittest.TestCase):
    def test_two_unresolved_two_candidates_no_words_stays_open(self):
        utterances = [
            u(0, "Grace Hopper", "morning"),
            u(1, "Speaker 2", "morning"),
            u(2, "Speaker 3", "hey"),
        ]
        result = naming.resolve_names(
            utterances, ["Grace Hopper", "Ada Lovelace", "Alan Turing"]
        )
        self.assertEqual(result.assignments, [])
        self.assertEqual({s.speaker for s in result.unresolved}, {"Speaker 2", "Speaker 3"})
        for unresolved in result.unresolved:
            self.assertEqual(sorted(unresolved.candidates), ["Ada Lovelace", "Alan Turing"])


class TestSelfIntroduction(unittest.TestCase):
    def test_a_clean_self_introduction_is_found_as_word_evidence(self):
        # Isolated at the `_word_matches` level rather than through
        # `resolve_names`: on a plain 1:1 with only one candidate left,
        # elimination alone already settles it (by design — elimination
        # outranks a text match, see the module docstring), so this checks
        # the self-introduction mechanism itself rather than which of two
        # correct answers a two-speaker case happens to take.
        utterances = [
            u(0, "Grace Hopper", "let's do quick introductions"),
            u(1, "Speaker 2", "hi, I'm Bob, nice to meet you all"),
        ]
        found = naming._word_matches(utterances, "Speaker 2", ["Bob Smith"])
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].candidate, "Bob Smith")
        self.assertIn("self-introduction", found[0].basis)

    def test_a_clean_self_introduction_wins_in_a_three_way_case(self):
        # With two unresolved speakers and two candidates, elimination alone
        # cannot fire — this is the shape where a self-introduction actually
        # decides the outcome through the full pipeline.
        utterances = [
            u(0, "Grace Hopper", "let's do quick introductions"),
            u(1, "Speaker 2", "hi, I'm Bob, nice to meet you all"),
            u(2, "Speaker 3", "good to be here too"),
        ]
        result = naming.resolve_names(utterances, ["Grace Hopper", "Bob Smith", "Carol Danvers"])
        assigned = {a.speaker: a.name for a in result.assignments}
        self.assertEqual(assigned.get("Speaker 2"), "Bob Smith")
        self.assertIn(
            "self-introduction",
            next(a.basis for a in result.assignments if a.speaker == "Speaker 2"),
        )
        # Speaker 3 then follows by elimination, cascading from the above.
        self.assertEqual(assigned.get("Speaker 3"), "Carol Danvers")

    def test_self_introduction_ignores_names_off_the_candidate_list(self):
        # The real case this guards against: a speaker in this plugin's own
        # test data says "hi, I'm Marjorie" while the attendee list (and the
        # correct answer) names someone else — a mismatch between how the
        # person introduces themselves and who the calendar says they are.
        # Matching free text alone would quote the wrong name; restricting to
        # candidates correctly asserts nothing here and leaves elimination to
        # settle it instead.
        utterances = [
            u(0, "Grace Hopper", "so what got you into infrastructure"),
            u(1, "Speaker 2", "of course, hi, I'm Marjorie, I've been here two years"),
        ]
        result = naming.resolve_names(utterances, ["Grace Hopper", "Barbara Liskov"])
        self.assertEqual(
            [(a.speaker, a.name, a.basis) for a in result.assignments],
            [("Speaker 2", "Barbara Liskov", "from the attendee list by elimination")],
        )

    def test_common_words_after_the_cue_are_not_mistaken_for_a_name(self):
        # "I'm not/still/just/…" is completed by ordinary words far more often
        # than by a name — this must never fire just because a cue matched.
        utterances = [
            u(0, "Speaker 1", "I'm not sure, I'm still looking at the numbers"),
        ]
        found = naming._word_matches(utterances, "Speaker 1", ["Bob Smith"])
        self.assertEqual(found, [])


class TestAddressedByName(unittest.TestCase):
    def test_a_vocative_address_in_the_next_turn_is_evidence(self):
        # Isolated at `_word_matches` for the same reason as the
        # self-introduction test above: on this plain 1:1, elimination alone
        # already settles the name, so this checks the address mechanism on
        # its own rather than the outcome of a case elimination would win.
        utterances = [
            u(0, "Speaker 2", "so that's roughly where things stand"),
            u(1, "Grace Hopper", "Thanks, Bob, that's really helpful."),
        ]
        found = naming._word_matches(utterances, "Speaker 2", ["Bob Smith"])
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].candidate, "Bob Smith")
        self.assertIn("addressed by name", found[0].basis)

    def test_a_diminutive_third_person_mention_is_not_an_address(self):
        # The shape a real Russian recording produced: a candidate's
        # diminutive appears immediately before a comma, so the vocative
        # *shape* is present — but it is a third-person mention ("the project
        # Tolya leads"), not someone being addressed. "Толя" is also a
        # different root from "Анатолий" rather than a case ending, so the
        # core match refuses it whatever the punctuation around it.
        text = "команда работает над проектом, который ведет Толя, а другая — над другим"
        found = naming._addressed_as(text, ["Анатолий Орлов"])
        self.assertEqual(found, [])

    def test_a_mention_two_turns_away_is_not_adjacent(self):
        utterances = [
            u(0, "Grace Hopper", "Bob, quick one for you."),
            u(1, "Grace Hopper", "actually never mind, let's move on"),
            u(2, "Speaker 2", "sure, go ahead"),
        ]
        found = naming._word_matches(utterances, "Speaker 2", ["Bob Smith"])
        self.assertEqual(found, [])


class TestAmbiguousWordEvidenceIsNotAsserted(unittest.TestCase):
    def test_two_candidates_mentioned_leaves_a_theory_not_an_assignment(self):
        utterances = [
            u(0, "Speaker 1", "hi, I'm Ada"),
            u(1, "Speaker 1", "well actually, I'm Grace, most people call me that"),
        ]
        result = naming.resolve_names(utterances, ["Ada Lovelace", "Grace Hopper"])
        self.assertEqual(result.assignments, [])
        self.assertEqual(len(result.unresolved), 1)
        theory = result.unresolved[0].leading_theory
        self.assertIsNotNone(theory)
        self.assertIn("not asserted", theory)


class TestCascade(unittest.TestCase):
    """Resolving one speaker by context can make the next one elimination."""

    def test_self_introduction_then_elimination_settles_the_third(self):
        utterances = [
            u(0, "Grace Hopper", "let's go round the table"),
            u(1, "Speaker 2", "hi, I'm Ada, good to meet you both"),
            u(2, "Speaker 3", "and I'm on the platform team"),
        ]
        result = naming.resolve_names(
            utterances, ["Grace Hopper", "Ada Lovelace", "Alan Turing"]
        )
        names = {a.speaker: a.name for a in result.assignments}
        self.assertEqual(names["Speaker 2"], "Ada Lovelace")
        self.assertEqual(names["Speaker 3"], "Alan Turing")
        self.assertEqual(
            [a.basis for a in result.assignments if a.speaker == "Speaker 3"],
            ["from the attendee list by elimination"],
        )
        self.assertEqual(result.unresolved, [])


class TestClaimContention(unittest.TestCase):
    def test_a_self_introduction_outranks_a_mere_address(self):
        # Speaker 2 is addressed as "Bob" by someone else; Speaker 3
        # introduces themselves as Bob. Self-introduction is first-person
        # evidence and wins the contested name.
        utterances = [
            u(0, "Grace Hopper", "Bob, go ahead whenever you're ready."),
            u(1, "Speaker 2", "sure, one second"),
            u(2, "Speaker 3", "hi, I'm Bob, sorry I'm late"),
        ]
        result = naming.resolve_names(utterances, ["Grace Hopper", "Bob Smith"])
        names = {a.speaker: a.name for a in result.assignments}
        self.assertEqual(names.get("Speaker 3"), "Bob Smith")
        self.assertNotIn("Speaker 2", names)


class TestRussianInflection(unittest.TestCase):
    """A Russian name spoken aloud is usually inflected — case endings — and
    will not literally match the nominative form an attendee list gives."""

    def test_the_core_matches_every_case_form_seen_in_real_data(self):
        # "Анатолий" (nominative), the four forms this plugin's own Russian
        # test recording actually contains variants of.
        for inflected in ("Анатолий", "Анатолия", "Анатолию", "Анатолием", "Анатолии"):
            with self.subTest(inflected=inflected):
                self.assertTrue(naming._token_matches(inflected, "Анатолий"))

    def test_a_different_name_sharing_no_prefix_does_not_match(self):
        self.assertFalse(naming._token_matches("Владимир", "Анатолий"))

    def test_exact_matching_would_have_missed_every_inflected_form(self):
        # The measurement this module's docstring claims, made concrete: a
        # naive equality check — what an English-shaped matcher would do —
        # scores zero on every inflected form.
        forms = ("Анатолия", "Анатолию", "Анатолием", "Анатолии")
        exact_hits = sum(1 for f in forms if f.lower() == "анатолий")
        core_hits = sum(1 for f in forms if naming._token_matches(f, "Анатолий"))
        self.assertEqual(exact_hits, 0)
        self.assertEqual(core_hits, len(forms))

    def test_a_diminutive_is_a_different_root_and_is_not_claimed(self):
        # "Толя" is a diminutive of "Анатолий", not a case ending — a
        # documented limitation, not a bug: guessing across roots is exactly
        # the kind of leap this module refuses to make.
        self.assertFalse(naming._token_matches("Толя", "Анатолий"))

    def test_latin_names_match_only_exactly_never_by_prefix(self):
        self.assertTrue(naming._token_matches("Mark", "Mark"))
        self.assertFalse(naming._token_matches("Markham", "Mark"))

    def test_end_to_end_russian_self_introduction(self):
        # The candidate list has to be given in the same script the meeting
        # is spoken in for word evidence to match at all — a Cyrillic
        # utterance is never compared against a Latin-spelled candidate, the
        # same way English is never compared against Cyrillic. Elimination
        # and the enrolled-print path do not have this constraint, since
        # neither ever compares text across scripts; see naming.py's module
        # docstring.
        utterances = [
            u(0, "Speaker 1", "меня зовут Анатолий, я веду этот трек"),
            u(1, "Speaker 2", "очень приятно"),
        ]
        result = naming.resolve_names(utterances, ["Анатолий Орлов", "Александр Королёв"])
        assigned = {a.speaker: a.name for a in result.assignments}
        self.assertEqual(assigned.get("Speaker 1"), "Анатолий Орлов")

    def test_end_to_end_russian_vocative_address(self):
        # The nominative form the attendee list carries is never said aloud
        # here at all — only the vocative-shaped mention "Анатолий, ты как" —
        # and the core match still recovers it because "Анатолий" is itself
        # already within the stripped core's reach of its own nominative.
        utterances = [
            u(0, "Speaker 1", "постой, я предупредил его заранее"),
            u(1, "Grace Hopper", "Анатолий, ты как, готов начинать?"),
        ]
        found = naming._addressed_as(utterances[1].text, ["Анатолий Орлов"])
        self.assertIn("Анатолий Орлов", found)


class TestSpeakerStats(unittest.TestCase):
    def test_first_substantive_skips_greetings_and_one_word_turns(self):
        items = [
            u(0, "Speaker 1", "hi"),
            u(1, "Speaker 1", "yeah"),
            u(2, "Speaker 1", "so I think we should wait until next week"),
        ]
        self.assertEqual(
            naming._first_substantive(items), "so I think we should wait until next week"
        )

    def test_falls_back_to_the_longest_turn_when_everything_is_short(self):
        items = [u(0, "Speaker 1", "hi"), u(1, "Speaker 1", "yeah sure")]
        self.assertEqual(naming._first_substantive(items), "yeah sure")

    def test_word_share_is_relative_to_the_whole_transcript(self):
        utterances = [
            u(0, "Grace Hopper", " ".join(["word"] * 8)),
            u(1, "Speaker 2", " ".join(["word"] * 2)),
        ]
        stats = naming._speaker_stats(utterances, ["Speaker 2"])
        self.assertAlmostEqual(stats["Speaker 2"].word_share, 0.2)


class TestRenderUnresolved(unittest.TestCase):
    def test_empty_list_renders_nothing(self):
        self.assertEqual(naming.render_unresolved([]), "")

    def test_a_speaker_is_rendered_with_its_evidence(self):
        unresolved = [
            naming.UnresolvedSpeaker(
                speaker="Speaker 2",
                first_utterance="so I think we should wait",
                turns=14,
                word_share=0.22,
                candidates=["Ada Lovelace"],
                leading_theory=None,
            )
        ]
        rendered = naming.render_unresolved(unresolved)
        self.assertIn("## Unresolved speakers", rendered)
        self.assertIn("Speaker 2", rendered)
        self.assertIn("14 turn(s)", rendered)
        self.assertIn("22%", rendered)
        self.assertIn("so I think we should wait", rendered)
        self.assertIn("Ada Lovelace", rendered)

    def test_a_leading_theory_is_included_when_present(self):
        unresolved = [
            naming.UnresolvedSpeaker(
                speaker="Speaker 3", first_utterance="hi", turns=1, word_share=0.1,
                candidates=["Ada Lovelace", "Grace Hopper"],
                leading_theory="mentioned as both Ada and Grace — not asserted",
            )
        ]
        rendered = naming.render_unresolved(unresolved)
        self.assertIn("Leading theory", rendered)
        self.assertIn("not asserted", rendered)


class TestSpellingPass(unittest.TestCase):
    def test_parses_correct_colon_misheard_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "names.txt"
            path.write_text(
                "# a comment\n"
                "\n"
                "Kubernetes: Cooper Netease, Cooper Net Es\n"
                "GitLab: Get Lab\n"
            )
            corrections = spelling.parse_names_file(path)
        self.assertEqual(len(corrections), 2)
        self.assertEqual(corrections[0].correct, "Kubernetes")
        self.assertEqual(corrections[0].misheard, ["Cooper Netease", "Cooper Net Es"])

    def test_a_bare_term_is_a_priming_entry_not_an_error(self):
        # This was refused while substitution was the file's only job, since a
        # term with nothing to correct did nothing. It now primes the
        # recogniser's vocabulary before decoding, which is the most useful
        # kind of entry there is — a primed term is usually recognised right
        # the first time instead of being repaired afterwards.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "names.txt"
            path.write_text("Kubernetes\nArgoCD:\n")
            corrections = spelling.parse_names_file(path)
        self.assertEqual([c.correct for c in corrections], ["Kubernetes", "ArgoCD"])
        self.assertEqual(corrections[0].misheard, [])
        self.assertEqual(corrections[1].misheard, [])

    def test_a_line_with_no_correct_spelling_is_still_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "names.txt"
            path.write_text(": Cooper Netease\n")
            with self.assertRaises(ValueError):
                spelling.parse_names_file(path)

    def test_the_prompt_carries_only_correct_spellings(self):
        # Feeding known mis-hearings to the recogniser would prime the very
        # strings this file exists to remove.
        corrections = [
            spelling.Correction("Kubernetes", ["Cooper Netease"]),
            spelling.Correction("ArgoCD", []),
        ]
        prompt = spelling.prompt_from(corrections)
        self.assertEqual(prompt, "Kubernetes, ArgoCD.")
        self.assertNotIn("Cooper", prompt)

    def test_the_prompt_is_capped_by_token_budget_not_entry_count(self):
        # The bug this replaced: the cap counted entries, so a real derived
        # list of 206 terms produced a 651-token prompt against a 224-token
        # decoder window. Whisper truncates such a prompt from the FRONT, so
        # the terms that mattered were silently dropped and the site codes at
        # the end of the file were primed instead.
        many = [spelling.Correction(f"Terminology{n:03d}", []) for n in range(300)]
        prompt = spelling.prompt_from(many)
        # Measured in the unit the budget is actually spent in. This assertion
        # used to multiply the budget by CHARS_PER_TOKEN and compare string
        # lengths, which has been wrong since the packing started counting
        # real tokens: 300 terms of this shape pack into 479 characters, well
        # inside 180 tokens, and the character estimate rejected it as
        # oversized. The same fallback the code uses applies when no
        # tokeniser is installed.
        tokenizer = spelling._load_tokenizer()
        budget = (
            spelling.PROMPT_TOKEN_BUDGET if tokenizer is not None
            else spelling.PROMPT_TOKEN_BUDGET * spelling.CHARS_PER_TOKEN
        )
        self.assertLessEqual(spelling._prompt_cost(prompt, tokenizer), budget)
        self.assertLess(len(spelling.primed_terms(many)), len(many))

    def test_terms_with_a_recorded_mishearing_survive_the_cap(self):
        # A term already observed to fail is the one priming is for, so it
        # outranks a term included only on the chance it helps.
        evidenced = spelling.Correction("Kubernetes", ["Cooper Netease"])
        filler = [spelling.Correction(f"Terminology{n:03d}", []) for n in range(300)]
        kept = spelling.primed_terms([*filler, evidenced])
        self.assertIn("Kubernetes", kept)

    def test_everything_listed_is_still_corrected_even_if_not_primed(self):
        # Nothing is lost to the cap: a term that did not fit the prompt is
        # repaired after recognition instead of prevented during it.
        filler = [spelling.Correction(f"Terminology{n:03d}", []) for n in range(300)]
        late = spelling.Correction("Analytical Engine", ["Аналитический Энджин"])
        corrections = [*filler, late]
        self.assertNotIn("Аналитический", spelling.prompt_from(corrections) or "")
        text, count = spelling.apply("мы обсуждаем Аналитический Энджин сегодня", corrections)
        self.assertIn("Analytical Engine", text)
        self.assertEqual(count, 1)

    def test_an_empty_vocabulary_primes_nothing(self):
        self.assertIsNone(spelling.prompt_from([]))

    def test_a_term_is_canonicalised_against_its_own_variants(self):
        # Measured on one real 55-minute recording: `Object Storage` 15 times
        # and `object storage` 9, both recognised correctly. A reader sees two
        # things and a search for one finds a fraction of the mentions.
        corrections = [spelling.Correction("Object Storage", [])]
        text, count = spelling.apply(
            "we use object storage for that, and Object Storage is fine", corrections
        )
        self.assertEqual(text, "we use Object Storage for that, and Object Storage is fine")
        self.assertEqual(count, 1)

    def test_text_already_canonical_counts_no_substitutions(self):
        corrections = [spelling.Correction("VPC", ["vpc"])]
        text, count = spelling.apply("the VPC is ready", corrections)
        self.assertEqual(text, "the VPC is ready")
        self.assertEqual(count, 0)

    def test_a_cyrillic_rendering_of_a_latin_name_is_recovered(self):
        # The destructive case from real audio: an English product name
        # rendered into Cyrillic is unrecoverable from context, but a list
        # carrying the observed rendering repairs it. This works because the
        # user supplies what they saw, not because the matcher is phonetic.
        corrections = [spelling.Correction("Linear", ["линии", "линером"])]
        text, count = spelling.apply(
            "чтобы посмотрел в линии, а не лазить с линером", corrections
        )
        self.assertIn("в Linear", text)
        self.assertIn("с Linear", text)
        self.assertEqual(count, 2)

    def test_whole_word_multi_word_substitution_and_count(self):
        corrections = [spelling.Correction("Kubernetes", ["Cooper Netease"])]
        text, count = spelling.apply(
            "we moved everything onto Cooper Netease last quarter", corrections
        )
        self.assertEqual(text, "we moved everything onto Kubernetes last quarter")
        self.assertEqual(count, 1)

    def test_it_never_matches_inside_a_longer_word(self):
        corrections = [spelling.Correction("Kubernetes", ["Cooper"])]
        text, count = spelling.apply("Cooperation is key here", corrections)
        self.assertEqual(text, "Cooperation is key here")
        self.assertEqual(count, 0)

    def test_case_insensitive_matching(self):
        corrections = [spelling.Correction("GitLab", ["get lab"])]
        text, count = spelling.apply("we host it on Get Lab now", corrections)
        self.assertEqual(text, "we host it on GitLab now")
        self.assertEqual(count, 1)

    def test_apply_to_utterances_counts_across_every_utterance(self):
        utterances = [
            u(0, "Speaker 1", "we use Get Lab for everything"),
            u(1, "Speaker 2", "yes, Get Lab is central to our workflow"),
        ]
        corrections = [spelling.Correction("GitLab", ["Get Lab"])]
        count = spelling.apply_to_utterances(utterances, corrections)
        self.assertEqual(count, 2)
        self.assertEqual(utterances[0].text, "we use GitLab for everything")

    def test_a_markdown_table_and_a_plain_list_parse_to_the_same_result(self):
        table = (
            "| Canonical | Renderings |\n"
            "| --- | --- |\n"
            "| `Kubernetes` | `Cooper Netease`, `Cooper Net Es` |\n"
            "| `GitLab` | `Get Lab` |\n"
        )
        plain = "Kubernetes: Cooper Netease, Cooper Net Es\nGitLab: Get Lab\n"
        with tempfile.TemporaryDirectory() as tmp:
            table_path = Path(tmp) / "vocab.md"
            table_path.write_text(table)
            plain_path = Path(tmp) / "vocab.txt"
            plain_path.write_text(plain)
            from_table = spelling.parse_names_file(table_path)
            from_plain = spelling.parse_names_file(plain_path)
        self.assertEqual(from_table, from_plain)

    def test_table_renderings_stop_at_the_first_em_dash(self):
        # Prose after the dash carries backticks too — a sentence explaining
        # that a rendering was *removed* would otherwise put it straight
        # back into the list.
        table = (
            "| Canonical | Renderings |\n"
            "| --- | --- |\n"
            "| `ArgoCD` | `Argo City` — previously also `Argo Seedy`, "
            "removed as too eager to fire |\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "vocab.md"
            path.write_text(table)
            corrections = spelling.parse_names_file(path)
        self.assertEqual(len(corrections), 1)
        self.assertEqual(corrections[0].misheard, ["Argo City"])

    def test_table_row_marked_excluded_is_left_out_entirely(self):
        table = (
            "| Canonical | Renderings |\n"
            "| --- | --- |\n"
            "| `Kubernetes` | `Cooper Netease` |\n"
            "| `handover` | excluded — an ordinary word |\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "vocab.md"
            path.write_text(table)
            corrections = spelling.parse_names_file(path)
        self.assertEqual([c.correct for c in corrections], ["Kubernetes"])

    def test_table_row_marked_prime_only_is_kept_and_flagged(self):
        table = (
            "| Canonical | Renderings |\n"
            "| --- | --- |\n"
            "| `handover` | `hand over` — prime only, an ordinary word |\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "vocab.md"
            path.write_text(table)
            corrections = spelling.parse_names_file(path)
        self.assertEqual(len(corrections), 1)
        self.assertTrue(corrections[0].prime_only)
        self.assertEqual(corrections[0].misheard, ["hand over"])

    def test_table_dedupes_by_canonical_case_insensitively_keeping_first(self):
        table = (
            "| Canonical | Renderings |\n"
            "| --- | --- |\n"
            "| `Kubernetes` | `Cooper Netease` |\n"
            "| `kubernetes` | `Cooper Net Es` |\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "vocab.md"
            path.write_text(table)
            corrections = spelling.parse_names_file(path)
        self.assertEqual(len(corrections), 1)
        self.assertEqual(corrections[0].misheard, ["Cooper Netease"])

    def test_table_skips_header_and_link_first_cells(self):
        table = (
            "| Canonical | Renderings |\n"
            "| --- | --- |\n"
            "| [See glossary](glossary.md) | `Something` |\n"
            "| `GitLab` | `Get Lab` |\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "vocab.md"
            path.write_text(table)
            corrections = spelling.parse_names_file(path)
        self.assertEqual([c.correct for c in corrections], ["GitLab"])

    def test_prime_only_entry_skips_self_match_but_applies_renderings(self):
        corrections = [spelling.Correction("handover", ["hand-over"], prime_only=True)]
        text, count = spelling.apply(
            "Handover starts Monday; please plan the hand-over carefully.",
            corrections,
        )
        # The sentence-initial "Handover" is left alone — no self-match.
        self.assertTrue(text.startswith("Handover starts Monday"))
        # The recorded mis-hearing is still corrected normally.
        self.assertIn("the handover carefully", text)
        self.assertEqual(count, 1)

    def test_prime_only_entry_still_primes(self):
        corrections = [
            spelling.Correction("handover", [], prime_only=True),
            spelling.Correction("Kubernetes", []),
        ]
        prompt = spelling.prompt_from(corrections)
        self.assertIn("handover", prompt)
        self.assertIn("Kubernetes", prompt)

    def test_real_token_count_is_used_when_a_tokenizer_is_available(self):
        # A fake tokeniser with a realistic, non-pessimistic ratio (about
        # four characters per token) should fit more terms under the same
        # budget than the pessimistic two-characters-per-token fallback
        # does — proof that the injected tokeniser's own count decided this,
        # not the character estimate.
        class FourCharsPerToken:
            def encode(self, text):
                return [0] * max(1, -(-len(text) // 4))

        terms = [spelling.Correction(f"Terminology{n:03d}", []) for n in range(80)]
        with mock.patch.object(spelling, "_load_tokenizer", return_value=FourCharsPerToken()):
            with_tokenizer = spelling.primed_terms(terms)
        with mock.patch.object(spelling, "_load_tokenizer", return_value=None):
            without_tokenizer = spelling.primed_terms(terms)
        self.assertGreater(len(with_tokenizer), len(without_tokenizer))

    def test_fallback_estimate_used_when_no_tokenizer_is_importable(self):
        # Same case the pre-existing budget test covers, run explicitly
        # against the "no tokeniser at all" path rather than relying on the
        # host running the test happening to lack mlx_whisper and tiktoken.
        terms = [spelling.Correction(f"Terminology{n:03d}", []) for n in range(300)]
        with mock.patch.object(spelling, "_load_tokenizer", return_value=None):
            kept = spelling.primed_terms(terms)
        budget = spelling.PROMPT_TOKEN_BUDGET * spelling.CHARS_PER_TOKEN
        used = sum(len(t) + 2 for t in kept)
        self.assertLessEqual(used, budget)
        self.assertLess(len(kept), len(terms))


class TestNameOrUnknownOnTwoSpeakers(unittest.TestCase):
    """In a two-person recording, `Speaker 2` must never reach the reader.

    With exactly two people a number carries nothing the meeting had not
    already said, while `Unknown` says the true thing: the tool could not
    determine who this was. Numbers earn their place from three speakers up.
    """

    def test_a_lone_numbered_speaker_becomes_unknown(self):
        utterances = [
            u(0, "Grace Hopper", "shall we start"),
            u(1, "Speaker 2", "yes, go ahead"),
            u(2, "Grace Hopper", "first item then"),
        ]
        replaced = naming.name_or_unknown(utterances)
        self.assertEqual(replaced, "Speaker 2")
        self.assertEqual(
            [utterance.speaker for utterance in utterances],
            ["Grace Hopper", naming.UNKNOWN_SPEAKER, "Grace Hopper"],
        )

    def test_three_speakers_keep_their_numbers(self):
        # Confirmed as the finished form: with three or more, telling them
        # apart is the point and a number is how that is done.
        utterances = [
            u(0, "Grace Hopper", "morning"),
            u(1, "Speaker 2", "morning"),
            u(2, "Speaker 3", "hello"),
        ]
        self.assertIsNone(naming.name_or_unknown(utterances))
        self.assertEqual(utterances[1].speaker, "Speaker 2")
        self.assertEqual(utterances[2].speaker, "Speaker 3")

    def test_two_unnamed_speakers_keep_their_numbers(self):
        # The case the instruction does not cover, and the one where the rule
        # has to yield: with neither speaker named, the numbers are the only
        # thing keeping two people apart. Replacing both with `Unknown` would
        # merge them and throw away the separation the diarizer established.
        utterances = [u(0, "Speaker 1", "hello"), u(1, "Speaker 2", "hello")]
        self.assertIsNone(naming.name_or_unknown(utterances))
        self.assertEqual(
            [utterance.speaker for utterance in utterances], ["Speaker 1", "Speaker 2"]
        )

    def test_both_named_changes_nothing(self):
        utterances = [u(0, "Grace Hopper", "hi"), u(1, "Ada Lovelace", "hi")]
        self.assertIsNone(naming.name_or_unknown(utterances))

    def test_unattributed_turns_do_not_count_as_a_speaker(self):
        # A turn no cluster could be matched to carries speaker None. It is a
        # different fact from an unnamed speaker and must not make a
        # two-speaker file look like a three-speaker one.
        utterances = [
            u(0, "Grace Hopper", "shall we start"),
            u(1, None, "mm"),
            u(2, "Speaker 2", "yes, go ahead"),
        ]
        self.assertEqual(naming.name_or_unknown(utterances), "Speaker 2")
        self.assertEqual(utterances[1].speaker, None)
        self.assertEqual(utterances[2].speaker, naming.UNKNOWN_SPEAKER)

    def test_a_single_speaker_file_is_untouched(self):
        utterances = [u(0, "Speaker 1", "just me talking")]
        self.assertIsNone(naming.name_or_unknown(utterances))


if __name__ == "__main__":
    unittest.main(verbosity=2)
