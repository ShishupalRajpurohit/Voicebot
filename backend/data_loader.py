# Data loader for persona and QA profile — loads configuration from JSON files.
import json
import os
from pathlib import Path
from typing import Any

# Base directory for data files
DATA_DIR = Path(__file__).parent / "data"

def load_json(filename: str) -> dict[str, Any]:
    """Load a JSON file from the data directory."""
    filepath = DATA_DIR / filename
    if not filepath.exists():
        raise FileNotFoundError(f"Required data file not found: {filepath}")
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


# Load persona data
_persona_data = load_json("persona.json")
_persona = _persona_data["persona"]

# Build the PERSONA prompt string from structured data
def build_persona_prompt() -> str:
    """Construct the system prompt from persona.json data."""
    p = _persona
    lines = [
        p["description"],
        "",
        "Verified background:",
    ]

    # Education
    for edu in p["background"]["education"]:
        lines.append(
            f"- {edu['degree']} from {edu['institution']}, {edu['university']}, "
            f"completed in {edu['completion_year']}."
        )

    # Experience
    for exp in p["background"]["experience"]:
        end = exp["end_date"] if exp["end_date"] != "present" else "present"
        lines.append(
            f"- {exp['title']} at {exp['company']} from {exp['start_date']} to {end}. "
            f"{exp['description']}."
        )

    lines.append("")
    lines.append("Known projects:")
    for proj in p["projects"]:
        tools_str = ", ".join(proj["tools"])
        lines.append(f"- {proj['name']}: {proj['description']}. Tools: {tools_str}.")

    lines.append("")
    lines.append("Skills:")
    skills = p["skills"]
    lines.append(f"- Programming: {', '.join(skills['programming'])}")
    lines.append(f"- Frameworks: {', '.join(skills['frameworks'])}")
    lines.append(f"- ML/AI: {', '.join(skills['ml_ai'])}")
    lines.append(f"- Data: {', '.join(skills['data'])}")
    lines.append(f"- Other: {', '.join(skills['other'])}")

    lines.append("")
    lines.append("Rules:")
    for rule in p["rules"]:
        lines.append(f"- {rule}")

    return "\n".join(lines)


PERSONA = build_persona_prompt()


# Load QA profile data
_qa_data = load_json("qa_profile.json")
_prepared_answers = _qa_data["prepared_answers"]
FALLBACK_RESPONSE = _qa_data["fallback_response"]
SIMILARITY_THRESHOLD = _qa_data.get("similar_question_threshold", 0.6)
MIN_KEYWORD_OVERLAP = _qa_data.get("min_keyword_overlap", {})
MAX_HISTORY_TURNS = _qa_data.get("max_history_turns", 6)


# Compile regex patterns for prepared answers
import re
_prepared_patterns = {}
for key, data in _prepared_answers.items():
    patterns = data["question_patterns"]
    # Combine patterns with OR
    combined = "|".join(f"({p})" for p in patterns)
    _prepared_patterns[key] = re.compile(combined, re.IGNORECASE)


def find_prepared_answer(question: str) -> str | None:
    """Return a prepared answer if the question matches known patterns."""
    text = question.lower()
    for key, pattern in _prepared_patterns.items():
        if pattern.search(text):
            return _prepared_answers[key]["answer"]
    return None


def _normalize_word(word: str) -> str:
    """Normalize word for matching (handle plurals, common suffixes)."""
    word = word.lower()
    # Handle common plural forms
    if word.endswith("ies"):
        return word[:-3] + "y"
    elif word.endswith("es") and len(word) > 3:
        return word[:-2]
    elif word.endswith("s") and len(word) > 2 and not word.endswith("ss"):
        return word[:-1]
    return word


def find_similar_prepared_answer(question: str) -> str | None:
    """Find a prepared answer for semantically similar questions using keyword overlap."""
    text = question.lower()
    words = set(_normalize_word(w) for w in re.findall(r"\b\w+\b", text))
    if not words:
        return None

    best_match = None
    best_overlap = 0
    best_key = None

    for key, data in _prepared_answers.items():
        # Use explicit keywords if available, otherwise fall back to pattern words
        if "keywords" in data:
            pattern_words = set(_normalize_word(w) for w in data["keywords"])
        else:
            pattern_words = set()
            for p in data["question_patterns"]:
                pattern_words.update(_normalize_word(w) for w in re.findall(r"\b\w+\b", p.lower()))

        if pattern_words:
            overlap = len(words & pattern_words)
            min_overlap = MIN_KEYWORD_OVERLAP.get(key, 1)
            # Require minimum keyword matches for a "similar" answer
            if overlap >= min_overlap and overlap > best_overlap:
                best_overlap = overlap
                best_match = data["answer"]
                best_key = key

    return best_match