"""Small, accessible UI primitives shared by the Streamlit views."""

from __future__ import annotations

from html import escape
import re

import streamlit as st


ICON_ACTION_KEY_PREFIX = "icon_action_"
_MATERIAL_ICON_PATTERN = re.compile(r"^[a-z0-9_]+$")


def _normalise_material_icon(icon: str) -> str:
    """Return a Streamlit Material Symbol token from a plain icon name."""
    icon_name = str(icon).strip()
    if icon_name.startswith(":material/") and icon_name.endswith(":"):
        icon_name = icon_name[len(":material/") : -1]

    if not _MATERIAL_ICON_PATTERN.fullmatch(icon_name):
        raise ValueError(
            "icon must be a Material Symbol name in snake_case, "
            "for example 'play_arrow'"
        )

    return f":material/{icon_name}:"


def _normalise_action_key(key: str) -> str:
    """Ensure action keys can be targeted without depending on DOM order."""
    action_key = str(key).strip()
    if not action_key:
        raise ValueError("key must not be empty")
    if action_key.startswith(ICON_ACTION_KEY_PREFIX):
        return action_key
    return f"{ICON_ACTION_KEY_PREFIX}{action_key}"


def icon_button(
    label: str,
    key: str,
    icon: str,
    help: str | None,
    disabled: bool = False,
    primary: bool = False,
    use_container_width: bool = False,
) -> bool:
    """Render a monochrome icon-only action with an accessible text label.

    The visible text is clipped by :func:`ui.styles.apply_theme`, rather than
    removed from the accessibility tree. ``label`` therefore remains the
    button's accessible name, while ``help`` supplies the hover/focus tooltip.

    ``key`` is automatically prefixed with ``icon_action_`` when needed so the
    component can be styled reliably through Streamlit's key-derived CSS class.
    ``icon`` accepts either ``"play_arrow"`` or ``":material/play_arrow:"``.
    """
    accessible_label = str(label).strip()
    if not accessible_label:
        raise ValueError("label must not be empty")

    return st.button(
        accessible_label,
        key=_normalise_action_key(key),
        help=help or accessible_label,
        type="primary" if primary else "secondary",
        icon=_normalise_material_icon(icon),
        disabled=disabled,
        width="stretch" if use_container_width else "content",
    )


def status_badge(label: str, running: bool) -> None:
    """Render a monochrome status badge that never relies on color alone."""
    safe_label = escape(str(label))
    state_class = "is-running" if running else "is-stopped"
    st.markdown(
        (
            f'<span class="ui-status-badge {state_class}">'
            '<span class="ui-status-badge__dot" aria-hidden="true"></span>'
            f'<span class="ui-status-badge__label">{safe_label}</span>'
            "</span>"
        ),
        unsafe_allow_html=True,
    )


__all__ = [
    "ICON_ACTION_KEY_PREFIX",
    "icon_button",
    "status_badge",
]
