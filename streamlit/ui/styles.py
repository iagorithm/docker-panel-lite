"""Monochrome visual system for the Streamlit control panel."""

from __future__ import annotations

import streamlit as st


THEME_CSS = r"""
:root {
    color-scheme: light;
    --ui-bg: #f5f5f3;
    --ui-surface: #ffffff;
    --ui-surface-subtle: #f7f7f6;
    --ui-surface-hover: #efefed;
    --ui-surface-pressed: #e8e8e5;
    --ui-text: #171717;
    --ui-text-secondary: #626262;
    --ui-text-tertiary: #6b6b6b;
    --ui-border: #e2e2df;
    --ui-border-strong: #c9c9c5;
    --ui-focus: #171717;
    --ui-disabled: #a6a6a2;
    --ui-radius-sm: 8px;
    --ui-radius-md: 12px;
    --ui-radius-lg: 16px;
    --ui-shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.035);
    --ui-shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.055), 0 8px 24px rgba(0, 0, 0, 0.025);
    --ui-ease: 150ms cubic-bezier(0.2, 0, 0, 1);
}

html,
body,
[data-testid="stAppViewContainer"],
.stApp {
    background: var(--ui-bg);
    color: var(--ui-text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
}

[data-testid="stAppViewContainer"] > .main,
[data-testid="stMain"] {
    overflow-x: hidden;
    background: var(--ui-bg);
}

[data-testid="stMainBlockContainer"],
.main .block-container {
    max-width: 1440px;
    padding: 1rem 1.5rem 2.5rem;
}

#MainMenu,
footer[data-testid="stFooter"],
[data-testid="stAppDeployButton"],
[data-testid="stToolbarActions"] {
    display: none !important;
}

header[data-testid="stHeader"] {
    background: transparent;
}

/* Native-feeling application sidebar. */
[data-testid="stSidebar"] {
    min-width: 14rem;
    overflow-x: hidden;
    background: #eeeeec;
    border-right: 1px solid var(--ui-border);
    box-shadow: none;
}

[data-testid="stSidebar"] > div:first-child,
[data-testid="stSidebarContent"] {
    background: transparent;
    padding: 1rem 0.75rem;
}

[data-testid="stSidebar"] [data-testid="stMarkdownContainer"] p,
[data-testid="stSidebar"] label {
    color: var(--ui-text-secondary);
}

.brand-lockup {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.25rem 0.35rem 1.65rem;
}

.brand-lockup > div:last-child {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.08rem;
}

.brand-lockup strong {
    color: var(--ui-text);
    font-size: 0.9rem;
    font-weight: 680;
    letter-spacing: -0.02em;
}

.brand-lockup > div:last-child span {
    overflow: hidden;
    color: var(--ui-text-tertiary);
    font-size: 0.68rem;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.brand-mark {
    position: relative;
    box-sizing: border-box;
    width: 2rem;
    height: 2rem;
    flex: 0 0 2rem;
    overflow: hidden;
    background: var(--ui-text);
    border: 1px solid var(--ui-text);
    border-radius: 9px;
    box-shadow: var(--ui-shadow-xs);
}

.brand-mark::before {
    position: absolute;
    inset: 0.48rem 0.42rem 0.54rem;
    content: "";
    border: 1.5px solid #ffffff;
    border-radius: 3px;
}

.brand-mark::after {
    position: absolute;
    top: 0.72rem;
    right: 0.68rem;
    width: 0.22rem;
    height: 0.22rem;
    content: "";
    background: #ffffff;
    border-radius: 999px;
}

.brand-mark span::before,
.brand-mark span::after {
    position: absolute;
    right: 0.62rem;
    bottom: 0.72rem;
    left: 0.62rem;
    height: 1px;
    content: "";
    background: #ffffff;
    opacity: 0.92;
}

.brand-mark span::after {
    bottom: 0.53rem;
    opacity: 0.6;
}

.brand-mark-large {
    width: 2.75rem;
    height: 2.75rem;
    margin-bottom: 1.1rem;
    border-radius: 12px;
}

.brand-mark-large::before {
    inset: 0.66rem 0.58rem 0.72rem;
}

.brand-mark-large::after {
    top: 0.98rem;
    right: 0.95rem;
}

.brand-mark-large span::before {
    right: 0.86rem;
    bottom: 0.96rem;
    left: 0.86rem;
}

.brand-mark-large span::after {
    right: 0.86rem;
    bottom: 0.72rem;
    left: 0.86rem;
}

.sidebar-label,
.inline-label {
    margin: 0 0 0.55rem !important;
    color: var(--ui-text-tertiary) !important;
    font-size: 0.68rem;
    font-weight: 680;
    letter-spacing: 0.085em;
    line-height: 1.2;
    text-transform: uppercase;
}

[data-testid="stSidebar"] [data-testid="stRadio"] [role="radiogroup"] {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 0.18rem;
    padding: 0;
    background: transparent;
}

[data-testid="stSidebar"] [data-testid="stRadio"] [role="radiogroup"] label {
    position: relative;
    box-sizing: border-box;
    display: flex;
    width: 100%;
    min-height: 2.35rem;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.65rem;
    color: var(--ui-text-secondary);
    border: 1px solid transparent;
    border-radius: var(--ui-radius-sm);
    font-size: 0.82rem;
    font-weight: 590;
}

[data-testid="stSidebar"] label[data-testid="stRadioOption"] > div > div > div:first-child {
    display: none;
}

[data-testid="stSidebar"] [data-testid="stRadio"] [role="radiogroup"] label::before {
    box-sizing: border-box;
    width: 0.82rem;
    height: 0.82rem;
    flex: 0 0 0.82rem;
    content: "";
    background: transparent;
    border: 1.5px solid var(--ui-text-tertiary);
    border-radius: 3px;
}

[data-testid="stSidebar"] [data-testid="stRadio"] [role="radiogroup"] label:hover {
    color: var(--ui-text);
    background: rgba(255, 255, 255, 0.45);
}

[data-testid="stSidebar"] [data-testid="stRadio"] [role="radiogroup"] label:has(input:checked) {
    color: var(--ui-text);
    background: var(--ui-surface);
    border-color: var(--ui-border);
    box-shadow: var(--ui-shadow-xs);
}

[data-testid="stSidebar"] [data-testid="stRadio"] [role="radiogroup"] label:has(input:checked)::before {
    background: var(--ui-text);
    border-color: var(--ui-text);
    box-shadow: inset 0 0 0 2px var(--ui-surface);
}

.session-user {
    display: flex;
    min-width: 0;
    min-height: 2.5rem;
    align-items: center;
    gap: 0.55rem;
}

.session-user > span {
    box-sizing: border-box;
    width: 1.7rem;
    height: 1.7rem;
    flex: 0 0 1.7rem;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border-strong);
    border-radius: 999px;
    box-shadow: inset 0 0 0 5px var(--ui-surface-subtle);
}

.session-user > div {
    display: flex;
    min-width: 0;
    flex-direction: column;
}

.session-user small {
    font-size: 0.62rem;
    line-height: 1.1;
}

.session-user strong {
    overflow: hidden;
    color: var(--ui-text);
    font-size: 0.76rem;
    font-weight: 620;
    text-overflow: ellipsis;
    white-space: nowrap;
}

[data-testid="stSidebarCollapseButton"] button,
[data-testid="stSidebarCollapsedControl"] button,
button[data-testid="stExpandSidebarButton"] {
    color: var(--ui-text-secondary);
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    box-shadow: var(--ui-shadow-xs);
}

[data-testid="stToolbar"]:has(button[data-testid="stExpandSidebarButton"]) {
    display: flex !important;
    visibility: visible !important;
    opacity: 1 !important;
    z-index: 1000;
}

/* Typography and supporting copy. */
h1,
h2,
h3,
h4,
h5,
h6 {
    color: var(--ui-text);
    letter-spacing: -0.025em;
}

p,
li,
label,
[data-testid="stMarkdownContainer"] {
    color: var(--ui-text);
}

[data-testid="stCaptionContainer"],
[data-testid="stCaptionContainer"] p,
small {
    color: var(--ui-text-secondary) !important;
}

a {
    color: var(--ui-text);
    text-decoration-color: var(--ui-border-strong);
    text-underline-offset: 3px;
}

a:hover {
    text-decoration-color: var(--ui-text);
}

hr,
[data-testid="stDivider"] {
    border-color: var(--ui-border) !important;
}

div[class*="st-key-container_toolbar"],
div[class*="st-key-repository_toolbar"] {
    width: min(100%, 30rem);
    margin-bottom: 0.35rem;
}

div[class*="st-key-container_toolbar"] div[class*="st-key-icon_action_"],
div[class*="st-key-repository_toolbar"] div[class*="st-key-icon_action_"] {
    width: 2.25rem !important;
    min-width: 2.25rem !important;
    flex: 0 0 2.25rem !important;
}

div[class*="st-key-container_toolbar"] div[class*="st-key-icon_action_"] button,
div[class*="st-key-repository_toolbar"] div[class*="st-key-icon_action_"] button {
    width: 2.25rem !important;
    max-width: 2.25rem !important;
    min-width: 2.25rem !important;
    min-height: 2.25rem !important;
}

div[class*="st-key-container_toolbar"] [data-baseweb="input"],
div[class*="st-key-container_toolbar"] [data-baseweb="base-input"],
div[class*="st-key-repository_toolbar"] [data-baseweb="input"],
div[class*="st-key-repository_toolbar"] [data-baseweb="base-input"] {
    min-height: 2.25rem;
    background: var(--ui-surface-hover) !important;
    border-color: transparent !important;
}

div[class*="st-key-container_toolbar"] input,
div[class*="st-key-repository_toolbar"] input {
    padding-inline: 0.7rem !important;
    background: var(--ui-surface-hover) !important;
    font-size: 0.78rem !important;
}

div[class*="st-key-repository_controls"] {
    width: min(100%, 42rem);
}

/* Authentication and forms. */
.auth-intro {
    padding-top: clamp(3rem, 10vh, 7rem);
    margin-bottom: 1.25rem;
}

div[class*="st-key-auth_shell"] {
    width: min(100%, 29rem);
    margin-inline: auto;
}

.auth-intro .eyebrow {
    margin: 0 0 0.45rem !important;
    color: var(--ui-text-tertiary) !important;
    font-size: 0.68rem;
    font-weight: 680;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.auth-intro h1 {
    margin: 0 !important;
    padding: 0 !important;
    font-size: clamp(1.85rem, 3vw, 2.35rem);
    font-weight: 650;
    letter-spacing: -0.045em;
    line-height: 1.08;
}

.auth-copy {
    max-width: 27rem;
    margin: 0.7rem 0 0 !important;
    color: var(--ui-text-secondary) !important;
    font-size: 0.9rem;
    line-height: 1.5;
}

[data-testid="stForm"] {
    padding: 1rem;
    background: var(--ui-surface-subtle);
    border: 1px solid var(--ui-border) !important;
    border-radius: var(--ui-radius-md);
}

div[class*="st-key-setup_form"] [data-testid="stForm"],
div[class*="st-key-login_form"] [data-testid="stForm"] {
    padding: 1.25rem;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow-sm);
}

div[class*="st-key-auth_shell"] [data-testid="InputInstructions"] {
    display: none !important;
}

.inline-label {
    margin-top: 1rem !important;
}

/* Resource rows and metadata. */
.resource-identity {
    display: flex;
    min-width: 0;
    min-height: 2.5rem;
    align-items: center;
    gap: 0.75rem;
}

.resource-glyph {
    position: relative;
    box-sizing: border-box;
    width: 2.25rem;
    height: 2.25rem;
    flex: 0 0 2.25rem;
    background: var(--ui-surface-subtle);
    border: 1px solid var(--ui-border-strong);
    border-radius: 9px;
}

.resource-glyph::before,
.resource-glyph::after,
.resource-glyph span::before {
    position: absolute;
    right: 0.48rem;
    left: 0.48rem;
    height: 0.3rem;
    content: "";
    border: 1px solid var(--ui-text-secondary);
    border-radius: 2px;
}

.resource-glyph::before {
    top: 0.45rem;
}

.resource-glyph::after {
    top: 0.92rem;
}

.resource-glyph span::before {
    top: 1.39rem;
}

.resource-glyph.repo-glyph::before {
    top: 0.51rem;
    height: 0.42rem;
    background: #dededb;
}

.resource-glyph.repo-glyph::after {
    top: 1.14rem;
    height: 0.42rem;
}

.resource-glyph.repo-glyph span::before {
    display: none;
}

.github-mark {
    display: grid;
    width: 2rem;
    height: 2rem;
    flex: 0 0 2rem;
    place-items: center;
    color: var(--ui-text);
}

.github-mark svg {
    display: block;
    width: 1.3rem;
    height: 1.3rem;
    fill: currentColor;
}

.resource-copy,
.resource-metadata {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.2rem;
}

.resource-copy strong,
.compact-title {
    overflow: hidden;
    color: var(--ui-text);
    font-size: 0.86rem;
    font-weight: 640;
    letter-spacing: -0.012em;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.resource-copy span,
.resource-metadata span,
.resource-metadata small {
    overflow: hidden;
    color: var(--ui-text-secondary);
    font-size: 0.7rem;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.resource-metadata small {
    color: var(--ui-text-tertiary) !important;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.64rem;
}

.confirmation-copy {
    display: flex;
    gap: 0.3rem;
    margin-top: 0.8rem;
    padding: 0.8rem 0.9rem;
    flex-direction: column;
    background: var(--ui-surface-subtle);
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius-sm);
}

.confirmation-copy strong {
    color: var(--ui-text);
    font-size: 0.8rem;
    font-weight: 640;
}

.confirmation-copy span {
    color: var(--ui-text-secondary);
    font-size: 0.72rem;
    line-height: 1.4;
}

.inline-token {
    display: inline-flex;
    max-width: 100%;
    padding: 0.3rem 0.45rem;
    overflow: hidden;
    color: var(--ui-text-secondary);
    background: var(--ui-surface-subtle) !important;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    font-size: 0.68rem;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.empty-state {
    display: flex;
    min-height: 15rem;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    flex-direction: column;
    text-align: center;
    background: rgba(255, 255, 255, 0.42);
    border: 1px dashed var(--ui-border-strong);
    border-radius: var(--ui-radius-lg);
}

.empty-state-icon {
    position: relative;
    box-sizing: border-box;
    width: 2.8rem;
    height: 2.8rem;
    margin-bottom: 0.95rem;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border-strong);
    border-radius: 12px;
    box-shadow: var(--ui-shadow-xs);
}

.empty-state-icon::before,
.empty-state-icon::after {
    position: absolute;
    right: 0.72rem;
    left: 0.72rem;
    height: 0.4rem;
    content: "";
    border: 1px solid var(--ui-text-tertiary);
    border-radius: 3px;
}

.empty-state-icon::before {
    top: 0.78rem;
}

.empty-state-icon::after {
    bottom: 0.78rem;
}

.empty-state h3 {
    margin: 0 !important;
    font-size: 0.96rem;
    font-weight: 640;
    letter-spacing: -0.02em;
}

.empty-state p {
    max-width: 27rem;
    margin: 0.45rem 0 0 !important;
    color: var(--ui-text-secondary) !important;
    font-size: 0.8rem;
    line-height: 1.45;
}

/* Premium surfaces: bordered Streamlit containers behave as cards. */
[data-testid="stVerticalBlockBorderWrapper"] {
    border-color: var(--ui-border) !important;
    border-radius: var(--ui-radius-md) !important;
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow-xs);
}

[data-testid="stVerticalBlockBorderWrapper"] > div {
    border-radius: inherit;
}

[data-testid="stExpander"] [data-testid="stVerticalBlockBorderWrapper"] {
    border-color: #e8e8e5 !important;
    box-shadow: none;
}

[data-testid="stMetric"] {
    min-height: 5.25rem;
    padding: 0.85rem 1rem;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius-md);
    box-shadow: var(--ui-shadow-xs);
}

[data-testid="stMetricLabel"] p {
    color: var(--ui-text-secondary) !important;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.015em;
}

[data-testid="stMetricValue"] {
    color: var(--ui-text);
    font-weight: 630;
    letter-spacing: -0.035em;
}

/* Buttons. Semantic hierarchy is expressed with value and weight, not hue. */
.stButton > button,
.stFormSubmitButton > button,
button[data-testid^="stBaseButton"] {
    min-height: 2.5rem;
    padding: 0.5rem 0.85rem;
    color: var(--ui-text);
    background: var(--ui-surface);
    border: 1px solid var(--ui-border-strong);
    border-radius: var(--ui-radius-sm);
    box-shadow: var(--ui-shadow-xs);
    font-size: 0.875rem;
    font-weight: 590;
    line-height: 1.15;
    transition: background var(--ui-ease), border-color var(--ui-ease),
        box-shadow var(--ui-ease), color var(--ui-ease), transform var(--ui-ease);
}

.stButton > button:hover:not(:disabled),
.stFormSubmitButton > button:hover:not(:disabled),
button[data-testid^="stBaseButton"]:hover:not(:disabled) {
    color: var(--ui-text);
    background: var(--ui-surface-hover);
    border-color: var(--ui-text-tertiary);
}

.stButton > button:active:not(:disabled),
.stFormSubmitButton > button:active:not(:disabled),
button[data-testid^="stBaseButton"]:active:not(:disabled) {
    background: var(--ui-surface-pressed);
    transform: translateY(1px);
}

button[kind="primary"],
button[data-testid="stBaseButton-primary"],
button[kind="primaryFormSubmit"],
button[data-testid="stBaseButton-primaryFormSubmit"] {
    color: #ffffff !important;
    background: var(--ui-text) !important;
    border-color: var(--ui-text) !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

button[kind="primary"] [data-testid="stMarkdownContainer"],
button[kind="primary"] [data-testid="stMarkdownContainer"] p,
button[kind="primaryFormSubmit"] [data-testid="stMarkdownContainer"],
button[kind="primaryFormSubmit"] [data-testid="stMarkdownContainer"] p {
    color: #ffffff !important;
}

button[kind="primary"]:hover:not(:disabled),
button[data-testid="stBaseButton-primary"]:hover:not(:disabled),
button[kind="primaryFormSubmit"]:hover:not(:disabled),
button[data-testid="stBaseButton-primaryFormSubmit"]:hover:not(:disabled) {
    color: #ffffff !important;
    background: #303030 !important;
    border-color: #303030 !important;
}

button[kind="tertiary"],
button[data-testid="stBaseButton-tertiary"] {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
}

button:disabled,
button[aria-disabled="true"] {
    color: var(--ui-disabled) !important;
    background: var(--ui-surface-subtle) !important;
    border-color: var(--ui-border) !important;
    box-shadow: none !important;
    cursor: not-allowed !important;
    opacity: 0.72;
}

button:focus-visible,
a:focus-visible,
input:focus-visible,
textarea:focus-visible,
select:focus-visible,
[tabindex]:focus-visible {
    outline: 2px solid var(--ui-focus) !important;
    outline-offset: 2px !important;
}

/* Icon-only actions. Text stays in the accessibility tree via clipping. */
div[class*="st-key-icon_action_"] button {
    width: 2.5rem !important;
    max-width: 2.5rem !important;
    min-width: 2.5rem !important;
    min-height: 2.5rem !important;
    padding: 0.5rem !important;
    gap: 0 !important;
}

div[class*="st-key-icon_action_"] {
    display: flex;
    align-items: center;
    justify-content: flex-end;
}

div[class*="st-key-icon_action_"] button [data-testid="stMarkdownContainer"] {
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    padding: 0 !important;
    margin: -1px !important;
    overflow: hidden !important;
    clip: rect(0, 0, 0, 0) !important;
    clip-path: inset(50%) !important;
    white-space: nowrap !important;
    border: 0 !important;
}

div[class*="st-key-icon_action_"] button span[data-testid="stIconMaterial"],
div[class*="st-key-icon_action_"] button .material-symbols-rounded {
    display: inline-flex !important;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.125rem;
    font-size: 1.125rem !important;
    line-height: 1 !important;
}

div[class*="st-key-repo_card_"] div[class*="st-key-icon_action_"] button[kind="secondary"] {
    background: transparent !important;
    border-color: transparent !important;
    box-shadow: none !important;
}

div[class*="st-key-repo_card_"] div[class*="st-key-icon_action_"] button[kind="secondary"]:hover:not(:disabled) {
    background: var(--ui-surface-hover) !important;
    border-color: transparent !important;
}

div[class*="st-key-env_table_inline_"] {
    width: min(100%, 42rem);
}

div[class*="st-key-env_json_inline_"] {
    width: min(100%, 32rem);
}

div[class*="st-key-env_json_inline_"] textarea {
    min-height: 7.25rem !important;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.74rem !important;
    line-height: 1.4 !important;
}

div[class*="st-key-cancel_env_"] button,
div[class*="st-key-save_env_"] button {
    min-height: 2rem !important;
    height: 2rem;
    padding: 0.3rem 0.65rem !important;
    border-radius: 0.5rem !important;
    font-size: 0.78rem !important;
}

/* Inputs and selectors. */
[data-baseweb="input"],
[data-baseweb="base-input"],
[data-baseweb="textarea"],
[data-baseweb="select"] > div,
[data-testid="stTextInput"] input,
[data-testid="stTextArea"] textarea,
[data-testid="stNumberInput"] input,
[data-testid="stDateInput"] input,
[data-testid="stTimeInput"] input {
    color: var(--ui-text) !important;
    background: var(--ui-surface) !important;
    border-color: var(--ui-border-strong) !important;
    border-radius: var(--ui-radius-sm) !important;
    box-shadow: none !important;
}

[data-baseweb="input"]:focus-within,
[data-baseweb="base-input"]:focus-within,
[data-baseweb="textarea"]:focus-within,
[data-baseweb="select"] > div:focus-within,
[data-testid="stTextInput"]:focus-within input,
[data-testid="stTextArea"]:focus-within textarea,
[data-testid="stNumberInput"]:focus-within input {
    border-color: var(--ui-focus) !important;
    box-shadow: none !important;
    outline: 2px solid var(--ui-focus) !important;
    outline-offset: 1px !important;
}

input::placeholder,
textarea::placeholder {
    color: var(--ui-text-tertiary) !important;
    opacity: 1;
}

[data-testid="stWidgetLabel"] p,
[data-testid="stWidgetLabel"] label,
.stTextInput label,
.stTextArea label,
.stSelectbox label,
.stRadio > label {
    color: var(--ui-text-secondary) !important;
    font-size: 0.78rem;
    font-weight: 590;
}

[data-baseweb="popover"],
[data-baseweb="menu"],
[role="listbox"] {
    color: var(--ui-text) !important;
    background: var(--ui-surface) !important;
    border-color: var(--ui-border) !important;
    border-radius: var(--ui-radius-md) !important;
    box-shadow: var(--ui-shadow-sm) !important;
}

[role="option"]:hover,
[role="option"][aria-selected="true"] {
    color: var(--ui-text) !important;
    background: var(--ui-surface-hover) !important;
}

input[type="checkbox"],
input[type="radio"] {
    accent-color: var(--ui-text);
}

/* Tabs become a compact segmented control. */
[data-baseweb="tab-list"] {
    width: fit-content;
    gap: 0.125rem;
    padding: 0.2rem;
    background: #eaeae8;
    border-radius: 10px;
}

button[data-baseweb="tab"] {
    min-height: 2.2rem;
    padding: 0.4rem 0.8rem;
    color: var(--ui-text-secondary);
    background: transparent;
    border: 0;
    border-radius: 7px;
    font-size: 0.84rem;
    font-weight: 570;
}

button[data-baseweb="tab"]:hover {
    color: var(--ui-text);
    background: rgba(255, 255, 255, 0.55);
}

button[data-baseweb="tab"][aria-selected="true"] {
    color: var(--ui-text);
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow-xs);
}

[data-baseweb="tab-highlight"],
[data-baseweb="tab-border"] {
    height: 0 !important;
    opacity: 0;
    pointer-events: none;
}

[data-testid="stTabs"] [data-baseweb="tab-panel"] {
    padding-top: 1.35rem;
}

/* Horizontal radios echo the segmented tab treatment while preserving inputs. */
[data-testid="stRadio"] [role="radiogroup"] {
    width: fit-content;
    gap: 0.15rem;
    padding: 0.2rem;
    background: #eaeae8;
    border-radius: 10px;
}

[data-testid="stRadio"] [role="radiogroup"] label {
    min-height: 2.15rem;
    margin: 0;
    padding: 0.35rem 0.65rem;
    color: var(--ui-text-secondary);
    border-radius: 7px;
    transition: background var(--ui-ease), color var(--ui-ease), box-shadow var(--ui-ease);
}

[data-testid="stRadio"] [role="radiogroup"] label:hover {
    color: var(--ui-text);
    background: rgba(255, 255, 255, 0.52);
}

[data-testid="stRadio"] [role="radiogroup"] label:has(input:checked) {
    color: var(--ui-text);
    background: var(--ui-surface);
    box-shadow: var(--ui-shadow-xs);
}

[data-testid="stRadio"] [role="radiogroup"] label:has(input:focus-visible) {
    outline: 2px solid var(--ui-focus);
    outline-offset: 2px;
}

/* Expanders and dialogs use quiet borders and restrained elevation. */
[data-testid="stExpander"] {
    overflow: hidden;
    background: var(--ui-surface);
    border: 1px solid var(--ui-border) !important;
    border-radius: var(--ui-radius-md) !important;
    box-shadow: var(--ui-shadow-xs);
}

[data-testid="stExpander"] details > summary {
    color: var(--ui-text);
    background: transparent;
    transition: background var(--ui-ease);
}

[data-testid="stExpander"] details > summary:hover {
    background: var(--ui-surface-subtle);
}

div[class*="st-key-repository_controls"] [data-testid="stExpander"] {
    background: transparent;
    box-shadow: none;
}

div[class*="st-key-repository_controls"] [data-testid="stExpander"] details > summary {
    display: none;
}

div[class*="st-key-repository_table"] > [data-testid="stVerticalBlockBorderWrapper"] {
    overflow: hidden;
    padding: 0 !important;
    background: rgba(255, 255, 255, 0.5);
    border-color: var(--ui-border) !important;
    box-shadow: none;
}

div[class*="st-key-container_table"] > [data-testid="stVerticalBlockBorderWrapper"] {
    overflow: hidden;
    padding: 0 !important;
    background: rgba(255, 255, 255, 0.5);
    border-color: var(--ui-border) !important;
    box-shadow: none;
}

div[class*="st-key-repository_table"] [data-testid="stVerticalBlock"],
div[class*="st-key-container_table"] [data-testid="stVerticalBlock"] {
    gap: 0;
}

div[class*="st-key-repo_card_"],
div[class*="st-key-container_card_"] {
    padding: 0.72rem 0.9rem;
}

.repository-row-divider,
.container-row-divider {
    width: 100%;
    height: 1px;
    background: var(--ui-border);
}

[role="dialog"] {
    color: var(--ui-text);
    background: var(--ui-surface) !important;
    border: 1px solid var(--ui-border) !important;
    border-radius: var(--ui-radius-lg) !important;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.16) !important;
}

/* Alerts remain semantic through their icon and copy, without chromatic coding. */
[data-testid="stAlert"],
div[role="alert"] {
    color: var(--ui-text) !important;
    background: var(--ui-surface-subtle) !important;
    border: 1px solid var(--ui-border-strong) !important;
    border-radius: var(--ui-radius-md) !important;
    box-shadow: none !important;
}

[data-testid="stAlert"] p,
[data-testid="stAlert"] svg,
div[role="alert"] p,
div[role="alert"] svg {
    color: var(--ui-text) !important;
    fill: currentColor !important;
}

/* Status primitive: filled versus outlined marker communicates state without hue. */
[data-testid="stMarkdownContainer"] p:has(> .ui-status-badge) {
    margin: 0;
}

.ui-status-badge {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    min-height: 1.65rem;
    gap: 0.4rem;
    padding: 0.25rem 0.55rem;
    color: var(--ui-text-secondary);
    background: var(--ui-surface-subtle);
    border: 1px solid var(--ui-border);
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 620;
    letter-spacing: 0.01em;
    line-height: 1;
    white-space: nowrap;
}

.ui-status-badge__dot {
    box-sizing: border-box;
    display: inline-block;
    width: 0.45rem;
    height: 0.45rem;
    flex: 0 0 0.45rem;
    border: 1.5px solid var(--ui-text-secondary);
    border-radius: 999px;
}

.ui-status-badge.is-running {
    color: var(--ui-text);
    background: #eeeeec;
    border-color: var(--ui-border-strong);
}

.ui-status-badge.is-running .ui-status-badge__dot {
    background: var(--ui-text);
    border-color: var(--ui-text);
    box-shadow: 0 0 0 2px var(--ui-surface);
}

.ui-status-badge.is-stopped .ui-status-badge__dot {
    background: transparent;
}

/* Read-only output and code surfaces. */
[data-testid="stCode"],
[data-testid="stCodeBlock"],
pre,
code {
    color: #242424;
    background: #efefed !important;
    border-color: var(--ui-border) !important;
    border-radius: var(--ui-radius-sm);
}

[data-testid="stSpinner"],
[data-testid="stSpinner"] p,
[data-testid="stSpinner"] svg {
    color: var(--ui-text) !important;
}

[data-testid="stProgress"] > div > div > div {
    background-color: var(--ui-text) !important;
}

/* Neutral scrollbar treatment. */
* {
    scrollbar-color: #b8b8b4 transparent;
    scrollbar-width: thin;
}

*::-webkit-scrollbar {
    width: 10px;
    height: 10px;
}

*::-webkit-scrollbar-thumb {
    background: #b8b8b4;
    border: 3px solid transparent;
    border-radius: 999px;
    background-clip: padding-box;
}

*::-webkit-scrollbar-track {
    background: transparent;
}

@media (max-width: 900px) {
    [data-testid="stMainBlockContainer"],
    .main .block-container {
        padding: 0.85rem 1rem 2.25rem;
    }

    [data-testid="stHorizontalBlock"] {
        gap: 0.65rem;
    }

    div[class*="st-key-container_card_"] [data-testid="stHorizontalBlock"],
    div[class*="st-key-repo_card_"] [data-testid="stHorizontalBlock"],
    div[class*="st-key-credential_card_"] [data-testid="stHorizontalBlock"] {
        flex-wrap: wrap;
    }

    div[class*="st-key-container_card_"] [data-testid="column"],
    div[class*="st-key-repo_card_"] [data-testid="column"],
    div[class*="st-key-credential_card_"] [data-testid="column"] {
        min-width: min(100%, 12rem);
        flex: 1 1 12rem !important;
    }
}

@media (max-width: 640px) {
    [data-testid="stMainBlockContainer"],
    .main .block-container {
        padding-inline: 0.75rem;
    }

    [data-baseweb="tab-list"],
    [data-testid="stRadio"] [role="radiogroup"] {
        max-width: 100%;
        overflow-x: auto;
    }

    div[class*="st-key-icon_action_"] button {
        width: 2.75rem !important;
        max-width: 2.75rem !important;
        min-width: 2.75rem !important;
        min-height: 2.75rem !important;
    }

    div[class*="st-key-container_card_"] [data-testid="column"],
    div[class*="st-key-repo_card_"] [data-testid="column"],
    div[class*="st-key-credential_card_"] [data-testid="column"] {
        width: 100% !important;
        min-width: 100% !important;
        flex-basis: 100% !important;
    }

    [data-testid="stForm"] [data-testid="stHorizontalBlock"] {
        flex-wrap: wrap;
    }

    [data-testid="stForm"] [data-testid="column"] {
        min-width: min(100%, 14rem);
        flex: 1 1 14rem !important;
    }

    .auth-intro {
        padding-top: 1.75rem;
    }
}

@media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
    }
}
"""


def apply_theme() -> None:
    """Inject the reusable monochrome theme into the current Streamlit page."""
    st.markdown(f"<style>{THEME_CSS}</style>", unsafe_allow_html=True)


__all__ = ["THEME_CSS", "apply_theme"]
