"""A small JSON Schema checker for tool arguments.

The tool catalogue is closed and its schemas use a handful of keywords, so the server checks
exactly those and nothing else: `type` (object, string, integer, boolean, array), `properties`,
`required`, `additionalProperties: false`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`
(characters), `maxItems`, `items` and a `oneOf` made of `required` groups. A keyword outside that
set in one of our schemas is a programming error and raises `ValueError` the first time a call is
checked, so the checker cannot silently accept what it does not understand.

A failed check returns one short message that names the argument, never its value: the value can
be peer-controlled text and the message goes back into a tool result.
"""

from __future__ import annotations

from typing import Any

_KNOWN = frozenset(
    {
        "type", "properties", "required", "additionalProperties", "enum", "minimum", "maximum",
        "minLength", "maxLength", "maxItems", "items", "oneOf", "description", "default",
    }
)  # fmt: skip


def check(schema: dict[str, Any], value: Any, path: str = "arguments") -> str | None:
    """None if `value` satisfies `schema`, else a message."""
    unknown = set(schema) - _KNOWN
    if unknown:
        raise ValueError(f"unsupported schema keyword(s): {', '.join(sorted(unknown))}")
    kind = schema.get("type")
    if kind is not None:
        problem = _type(kind, value, path)
        if problem:
            return problem
    if "enum" in schema and value not in schema["enum"]:
        return f"{path} must be one of {', '.join(map(str, schema['enum']))}"
    if isinstance(value, bool):
        pass
    elif isinstance(value, int):
        if "minimum" in schema and value < schema["minimum"]:
            return f"{path} must be at least {schema['minimum']}"
        if "maximum" in schema and value > schema["maximum"]:
            return f"{path} must be at most {schema['maximum']}"
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            return f"{path} must not be shorter than {schema['minLength']} characters"
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            return f"{path} must not be longer than {schema['maxLength']} characters"
    if isinstance(value, list):
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            return f"{path} must have at most {schema['maxItems']} items"
        if "items" in schema:
            for i, item in enumerate(value):
                problem = check(schema["items"], item, f"{path}[{i}]")
                if problem:
                    return problem
    if isinstance(value, dict):
        for name in schema.get("required", ()):
            if name not in value:
                return f"{path}.{name} is required"
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for name in value:
                if name not in props:
                    return f"{path}.{name} is not an argument of this tool"
        for name, sub in props.items():
            if name in value:
                problem = check(sub, value[name], f"{path}.{name}")
                if problem:
                    return problem
        if "oneOf" in schema:
            matching = [g for g in schema["oneOf"] if all(r in value for r in g.get("required", ()))]
            if len(matching) != 1:
                options = " or ".join("+".join(g.get("required", ())) for g in schema["oneOf"])
                return f"{path} needs exactly one of: {options}"
    return None


def _type(kind: str, value: Any, path: str) -> str | None:
    ok = {
        "object": isinstance(value, dict),
        "string": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "array": isinstance(value, list),
    }.get(kind)
    if ok is None:
        raise ValueError(f"unsupported schema type {kind!r}")
    return None if ok else f"{path} must be {'an' if kind in ('object', 'integer', 'array') else 'a'} {kind}"
