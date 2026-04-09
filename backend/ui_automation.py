from __future__ import annotations

import subprocess
from dataclasses import dataclass
from typing import Optional

from automation.applescript import escape_applescript_string, run_applescript_lines
from utils.logger import get_logger


logger = get_logger()
FIELD_SEPARATOR = chr(30)
RECORD_SEPARATOR = chr(31)
TEXT_FIELD_ROLES = {"AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"}
BUTTON_ROLES = {"AXButton", "AXLink"}
SUPPORTED_ROLES = TEXT_FIELD_ROLES | BUTTON_ROLES
SUPPORTED_BROWSERS = {
    "Safari",
    "Google Chrome",
    "Arc",
    "Brave Browser",
    "Microsoft Edge",
}


@dataclass(frozen=True)
class UIElementCandidate:
    ui_index: int
    role: str
    subrole: Optional[str]
    label: Optional[str]
    description: Optional[str]
    placeholder: Optional[str]
    value: Optional[str] = None
    role_description: Optional[str] = None
    source_class: str = "generic"
    x: Optional[int] = None
    y: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None

    @property
    def display_label(self) -> str:
        return (
            self.label
            or self.description
            or self.placeholder
            or self.value
            or ("Button" if self.role in BUTTON_ROLES else "Text field")
        )


@dataclass(frozen=True)
class FrontmostUISnapshot:
    app_name: str
    bundle_id: Optional[str]
    elements: tuple[UIElementCandidate, ...]


@dataclass(frozen=True)
class FocusedUIElementState:
    role: Optional[str]
    subrole: Optional[str]
    label: Optional[str]
    description: Optional[str]
    placeholder: Optional[str]
    role_description: Optional[str]
    source_class: str = "generic"

    @property
    def display_label(self) -> str:
        return (
            self.label
            or self.description
            or self.placeholder
            or ("Button" if self.role in BUTTON_ROLES else "Text field")
        )


class UIAutomationService:
    def __init__(self, *, timeout_sec: float = 3.5) -> None:
        self.timeout_sec = max(timeout_sec, 0.5)

    def capture_frontmost_ui_snapshot(self) -> FrontmostUISnapshot:
        raw = self._run_applescript(self._build_snapshot_applescript())

        app_name, bundle_id, records_blob = (raw.split(FIELD_SEPARATOR, 2) + ["", "", ""])[:3]
        elements: list[UIElementCandidate] = []
        if records_blob.strip():
            for record in records_blob.split(RECORD_SEPARATOR):
                if not record.strip():
                    continue
                parts = (record.split(FIELD_SEPARATOR) + ["", "", "", "", "", "", "", "", "", "", ""])[:11]
                ui_index = int(parts[0]) if parts[0].isdigit() else 0
                role = parts[1].strip()
                if ui_index <= 0 or role not in SUPPORTED_ROLES:
                    continue
                parsed_source_class = self._normalize(parts[8]) or "generic"
                if app_name.strip() in SUPPORTED_BROWSERS and parsed_source_class != "page_content":
                    parsed_source_class = "browser_chrome"
                elements.append(UIElementCandidate(
                    ui_index=ui_index,
                    role=role,
                    subrole=self._normalize(parts[2]),
                    label=self._normalize(parts[3]),
                    description=self._normalize(parts[4]),
                    placeholder=self._normalize(parts[5]),
                    value=self._normalize(parts[6]),
                    role_description=self._normalize(parts[7]),
                    source_class=parsed_source_class,
                    x=self._parse_pair_value(parts[9], 0),
                    y=self._parse_pair_value(parts[9], 1),
                    width=self._parse_pair_value(parts[10], 0),
                    height=self._parse_pair_value(parts[10], 1),
                ))

        return FrontmostUISnapshot(
            app_name=app_name.strip() or "Unknown",
            bundle_id=self._normalize(bundle_id),
            elements=tuple(elements),
        )

    def capture_focused_ui_element(self) -> FocusedUIElementState:
        raw = self._run_applescript(self._build_focused_element_applescript())
        parts = (raw.split(FIELD_SEPARATOR) + ["", "", "", "", "", "", ""])[:7]
        return FocusedUIElementState(
            role=self._normalize(parts[0]),
            subrole=self._normalize(parts[1]),
            label=self._normalize(parts[2]),
            description=self._normalize(parts[3]),
            placeholder=self._normalize(parts[4]),
            role_description=self._normalize(parts[5]),
            source_class=self._normalize(parts[6]) or "generic",
        )

    def execute_auto_ui_action(
        self,
        *,
        action_type: str,
        ui_index: int,
        expected_app_name: str,
        expected_bundle_id: Optional[str],
        expected_role: Optional[str],
    ) -> None:
        if action_type not in {"focus_field", "press_button", "focus_browser_address_bar", "focus_primary_chat_input", "press_primary_chat_send"}:
            raise RuntimeError(f"Unsupported UI action: {action_type}")

        if action_type == "focus_browser_address_bar":
            self._run_applescript(
                self._build_focus_browser_address_bar_applescript(
                    expected_app_name=expected_app_name,
                    expected_bundle_id=expected_bundle_id,
                )
            )
            return

        if action_type == "focus_primary_chat_input":
            self._run_applescript(
                self._build_focus_primary_chat_input_applescript(
                    expected_app_name=expected_app_name,
                    expected_bundle_id=expected_bundle_id,
                )
            )
            self._verify_primary_chat_input_focus(
                expected_app_name=expected_app_name,
                expected_bundle_id=expected_bundle_id,
            )
            return

        if action_type == "press_primary_chat_send":
            self._run_applescript(
                self._build_press_primary_chat_send_applescript(
                    expected_app_name=expected_app_name,
                    expected_bundle_id=expected_bundle_id,
                )
            )
            return

        self._run_applescript(
            self._build_execute_action_applescript(
                action_type=action_type,
                ui_index=ui_index,
                expected_app_name=expected_app_name,
                expected_bundle_id=expected_bundle_id,
                expected_role=expected_role,
            )
        )

    def _build_snapshot_applescript(self) -> list[str]:
        return [
            'set fieldSep to (character id 30)',
            'set recordSep to (character id 31)',
            'set supportedRoles to {"AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXButton", "AXLink"}',
            'set browserApps to {"Safari", "Google Chrome", "Arc", "Brave Browser", "Microsoft Edge"}',
            'set maxItems to 180',
            'set maxPageItems to 120',
            'set maxChromeItems to 60',
            'set serializedItems to {}',
            'set itemIndex to 0',
            'using terms from application "System Events"',
            'on serializeCandidate(itemNumber, roleValue, subroleValue, titleValue, descriptionValue, placeholderValue, valueText, roleDescriptionValue, sourceClass, positionText, sizeText)',
            'global serializedItems, fieldSep',
            'copy ((itemNumber as text) & fieldSep & roleValue & fieldSep & subroleValue & fieldSep & titleValue & fieldSep & descriptionValue & fieldSep & placeholderValue & fieldSep & valueText & fieldSep & roleDescriptionValue & fieldSep & sourceClass & fieldSep & positionText & fieldSep & sizeText) to end of serializedItems',
            'end serializeCandidate',
            'on formatPair(listValue)',
            'if class of listValue is list and (count of listValue) >= 2 then',
            'return ((item 1 of listValue) as text) & "," & ((item 2 of listValue) as text)',
            'end if',
            'return ""',
            'end formatPair',
            'on findFirstWebArea(elementList, maxDepth)',
            'if maxDepth <= 0 then',
            'return missing value',
            'end if',
            'repeat with itemRef in elementList',
            'set roleValue to ""',
            'set childItems to missing value',
            'try',
            'set roleValue to value of attribute "AXRole" of itemRef',
            'end try',
            'if roleValue is "AXWebArea" then',
            'return itemRef',
            'end if',
            'try',
            'set childItems to UI elements of itemRef',
            'if (count of childItems) > 0 then',
            'set nestedArea to my findFirstWebArea(childItems, maxDepth - 1)',
            'if nestedArea is not missing value then',
            'return nestedArea',
            'end if',
            'end if',
            'end try',
            'end repeat',
            'return missing value',
            'end findFirstWebArea',
            'on walkUIElements(elementList, sourceClass, maxItems, supportedRoles, skipWebAreaDescendants)',
            'global itemIndex',
            'repeat with itemRef in elementList',
            'if itemIndex >= maxItems then',
            'exit repeat',
            'end if',
            'set roleValue to ""',
            'set childItems to missing value',
            'try',
            'set roleValue to value of attribute "AXRole" of itemRef',
            'end try',
            'set nextSourceClass to sourceClass',
            'if roleValue is "AXWebArea" then',
            'set nextSourceClass to "page_content"',
            'if skipWebAreaDescendants then',
            'set childItems to {}',
            'else',
            'set childItems to missing value',
            'end if',
            'end if',
            'if roleValue is in supportedRoles then',
            'set itemIndex to itemIndex + 1',
            'set subroleValue to ""',
            'set titleValue to ""',
            'set descriptionValue to ""',
            'set placeholderValue to ""',
            'set valueText to ""',
            'set roleDescriptionValue to ""',
            'set positionText to ""',
            'set sizeText to ""',
            'try',
            'set subroleValue to value of attribute "AXSubrole" of itemRef',
            'end try',
            'try',
            'set titleValue to value of attribute "AXTitle" of itemRef',
            'end try',
            'try',
            'set descriptionValue to value of attribute "AXDescription" of itemRef',
            'end try',
            'try',
            'set placeholderValue to value of attribute "AXPlaceholderValue" of itemRef',
            'end try',
            'try',
            'set valueText to (value of attribute "AXValue" of itemRef) as text',
            'end try',
            'try',
            'set roleDescriptionValue to value of attribute "AXRoleDescription" of itemRef',
            'end try',
            'try',
            'set positionText to my formatPair(position of itemRef)',
            'end try',
            'try',
            'set sizeText to my formatPair(size of itemRef)',
            'end try',
            'my serializeCandidate(itemIndex, roleValue, subroleValue, titleValue, descriptionValue, placeholderValue, valueText, roleDescriptionValue, nextSourceClass, positionText, sizeText)',
            'if itemIndex >= maxItems then',
            'exit repeat',
            'end if',
            'end if',
            'try',
            'if childItems is missing value then set childItems to UI elements of itemRef',
            'if (count of childItems) > 0 then',
            'my walkUIElements(childItems, nextSourceClass, maxItems, supportedRoles, skipWebAreaDescendants)',
            'end if',
            'end try',
            'if itemIndex >= maxItems then',
            'exit repeat',
            'end if',
            'end repeat',
            'end walkUIElements',
            'end using terms from',
            'tell application "System Events"',
            'set frontApp to first application process whose frontmost is true',
            'set appName to name of frontApp',
            'set bundleId to ""',
            'try',
            'set bundleId to bundle identifier of frontApp',
            'end try',
            'try',
            'if (count of windows of frontApp) > 0 then',
            'set rootItems to UI elements of front window of frontApp',
            'if appName is in browserApps then',
            'set webArea to my findFirstWebArea(rootItems, 8)',
            'if webArea is not missing value then',
            'my walkUIElements({webArea}, "page_content", maxPageItems, supportedRoles, false)',
            'end if',
            'if itemIndex < maxItems then',
            'my walkUIElements(rootItems, "browser_chrome", maxChromeItems, supportedRoles, true)',
            'end if',
            'else',
            'my walkUIElements(rootItems, "generic", maxItems, supportedRoles, false)',
            'end if',
            'end if',
            'end try',
            'end tell',
            'set AppleScript\'s text item delimiters to recordSep',
            'set serializedText to serializedItems as text',
            'set AppleScript\'s text item delimiters to ""',
            'return appName & fieldSep & bundleId & fieldSep & serializedText',
        ]

    def _build_execute_action_applescript(
        self,
        *,
        action_type: str,
        ui_index: int,
        expected_app_name: str,
        expected_bundle_id: Optional[str],
        expected_role: Optional[str],
    ) -> list[str]:
        action_lines = [
            'try',
            'set value of attribute "AXFocused" of targetElement to true',
            'on error',
            'perform action "AXPress" of targetElement',
            'end try',
        ] if action_type == "focus_field" else [
            'perform action "AXPress" of targetElement',
        ]

        script = [
            'set supportedRoles to {"AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXButton", "AXLink"}',
            'set candidateCounter to 0',
            'using terms from application "System Events"',
            'on findCandidate(elementList, desiredIndex, supportedRoles)',
            'global candidateCounter',
            'repeat with itemRef in elementList',
            'set roleValue to ""',
            'try',
            'set roleValue to value of attribute "AXRole" of itemRef',
            'end try',
            'if roleValue is in supportedRoles then',
            'set candidateCounter to candidateCounter + 1',
            'if candidateCounter is desiredIndex then',
            'return itemRef',
            'end if',
            'end if',
            'try',
            'set childItems to UI elements of itemRef',
            'if (count of childItems) > 0 then',
            'set nestedTarget to my findCandidate(childItems, desiredIndex, supportedRoles)',
            'if nestedTarget is not missing value then',
            'return nestedTarget',
            'end if',
            'end if',
            'end try',
            'end repeat',
            'return missing value',
            'end findCandidate',
            'end using terms from',
            'tell application "System Events"',
            'set frontApp to first application process whose frontmost is true',
            'set currentAppName to name of frontApp',
            'set currentBundleId to ""',
            'try',
            'set currentBundleId to bundle identifier of frontApp',
            'end try',
        ]

        if expected_bundle_id:
            escaped_bundle_id = escape_applescript_string(expected_bundle_id)
            script.append(
                f'if currentBundleId is not "{escaped_bundle_id}" then error "The frontmost app changed before the action could run."'
            )
        else:
            escaped_app_name = escape_applescript_string(expected_app_name)
            script.append(
                f'if currentAppName is not "{escaped_app_name}" then error "The frontmost app changed before the action could run."'
            )

        script.extend([
            'if (count of windows of frontApp) = 0 then error "The frontmost app does not expose a window for UI automation."',
            f'set desiredIndex to {ui_index}',
            'set targetElement to my findCandidate((UI elements of front window of frontApp), desiredIndex, supportedRoles)',
            'if targetElement is missing value then error "The targeted UI element could not be found."',
        ])

        if expected_role:
            escaped_role = escape_applescript_string(expected_role)
            script.extend([
                'set currentRole to ""',
                'try',
                'set currentRole to value of attribute "AXRole" of targetElement',
                'end try',
                f'if currentRole is not "{escaped_role}" then error "The targeted UI element no longer matches the expected role."',
            ])

        script.extend(action_lines)
        script.append('end tell')
        return script

    def _build_focus_browser_address_bar_applescript(
        self,
        *,
        expected_app_name: str,
        expected_bundle_id: Optional[str],
    ) -> list[str]:
        script = [
            'tell application "System Events"',
            'set frontApp to first application process whose frontmost is true',
            'set currentAppName to name of frontApp',
            'set currentBundleId to ""',
            'try',
            'set currentBundleId to bundle identifier of frontApp',
            'end try',
        ]
        if expected_bundle_id:
            escaped_bundle_id = escape_applescript_string(expected_bundle_id)
            script.append(
                f'if currentBundleId is not "{escaped_bundle_id}" then error "The frontmost app changed before the action could run."'
            )
        else:
            escaped_app_name = escape_applescript_string(expected_app_name)
            script.append(
                f'if currentAppName is not "{escaped_app_name}" then error "The frontmost app changed before the action could run."'
            )

        script.extend([
            'keystroke "l" using command down',
            'end tell',
        ])
        return script

    def _build_focus_primary_chat_input_applescript(
        self,
        *,
        expected_app_name: str,
        expected_bundle_id: Optional[str],
    ) -> list[str]:
        script = [
            'set supportedRoles to {"AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"}',
            'using terms from application "System Events"',
            'on findFirstWebArea(elementList, maxDepth)',
            'if maxDepth <= 0 then',
            'return missing value',
            'end if',
            'repeat with itemRef in elementList',
            'set roleValue to ""',
            'try',
            'set roleValue to value of attribute "AXRole" of itemRef',
            'end try',
            'if roleValue is "AXWebArea" then',
            'return itemRef',
            'end if',
            'try',
            'set childItems to UI elements of itemRef',
            'if (count of childItems) > 0 then',
            'set nestedArea to my findFirstWebArea(childItems, maxDepth - 1)',
            'if nestedArea is not missing value then',
            'return nestedArea',
            'end if',
            'end if',
            'end try',
            'end repeat',
            'return missing value',
            'end findFirstWebArea',
            'on findFirstTextInput(elementList, maxDepth, supportedRoles)',
            'if maxDepth <= 0 then',
            'return missing value',
            'end if',
            'repeat with itemRef in elementList',
            'set roleValue to ""',
            'try',
            'set roleValue to value of attribute "AXRole" of itemRef',
            'end try',
            'if roleValue is in supportedRoles then',
            'return itemRef',
            'end if',
            'try',
            'set childItems to UI elements of itemRef',
            'if (count of childItems) > 0 then',
            'set nestedTarget to my findFirstTextInput(childItems, maxDepth - 1, supportedRoles)',
            'if nestedTarget is not missing value then',
            'return nestedTarget',
            'end if',
            'end if',
            'end try',
            'end repeat',
            'return missing value',
            'end findFirstTextInput',
            'end using terms from',
            'tell application "System Events"',
            'set frontApp to first application process whose frontmost is true',
            'set currentAppName to name of frontApp',
            'set currentBundleId to ""',
            'try',
            'set currentBundleId to bundle identifier of frontApp',
            'end try',
        ]
        if expected_bundle_id:
            escaped_bundle_id = escape_applescript_string(expected_bundle_id)
            script.append(
                f'if currentBundleId is not "{escaped_bundle_id}" then error "The frontmost app changed before the action could run."'
            )
        else:
            escaped_app_name = escape_applescript_string(expected_app_name)
            script.append(
                f'if currentAppName is not "{escaped_app_name}" then error "The frontmost app changed before the action could run."'
            )

        script.extend([
            'if (count of windows of frontApp) = 0 then',
            'error "The frontmost app does not expose a window for UI automation."',
            'end if',
            'set rootItems to UI elements of front window of frontApp',
            'set webArea to my findFirstWebArea(rootItems, 12)',
            'if webArea is missing value then',
            'error "The browser page did not expose a web area for chat input automation."',
            'end if',
            'set targetElement to missing value',
            'try',
            'set targetElement to my findFirstTextInput((UI elements of webArea), 10, supportedRoles)',
            'end try',
            'if targetElement is missing value then',
            'error "The browser page did not expose a page chat input."',
            'end if',
            'try',
            'set value of attribute "AXFocused" of targetElement to true',
            'on error',
            'perform action "AXPress" of targetElement',
            'end try',
            'end tell',
        ])
        return script

    def _build_press_primary_chat_send_applescript(
        self,
        *,
        expected_app_name: str,
        expected_bundle_id: Optional[str],
    ) -> list[str]:
        script = [
            'set supportedRoles to {"AXButton", "AXLink"}',
            'set primaryTerms to {"send", "send message", "send prompt", "submit", "submit prompt"}',
            'set secondaryTerms to {"ask", "continue", "respond"}',
            'using terms from application "System Events"',
            'on normalizeText(valueText)',
            'set textValue to ""',
            'try',
            'set textValue to (valueText as text)',
            'end try',
            'return textValue',
            'end normalizeText',
            'on matchesAnyTerm(candidateText, termList)',
            'repeat with termValue in termList',
            'ignoring case',
            'if candidateText contains (termValue as text) then',
            'return true',
            'end if',
            'end ignoring',
            'end repeat',
            'return false',
            'end matchesAnyTerm',
            'on findFirstWebArea(elementList, maxDepth)',
            'if maxDepth <= 0 then',
            'return missing value',
            'end if',
            'repeat with itemRef in elementList',
            'set roleValue to ""',
            'try',
            'set roleValue to value of attribute "AXRole" of itemRef',
            'end try',
            'if roleValue is "AXWebArea" then',
            'return itemRef',
            'end if',
            'try',
            'set childItems to UI elements of itemRef',
            'if (count of childItems) > 0 then',
            'set nestedArea to my findFirstWebArea(childItems, maxDepth - 1)',
            'if nestedArea is not missing value then',
            'return nestedArea',
            'end if',
            'end if',
            'end try',
            'end repeat',
            'return missing value',
            'end findFirstWebArea',
            'on findMatchingPressable(elementList, maxDepth, supportedRoles, primaryTerms, secondaryTerms)',
            'if maxDepth <= 0 then',
            'return missing value',
            'end if',
            'set fallbackElement to missing value',
            'repeat with itemRef in elementList',
            'set roleValue to ""',
            'try',
            'set roleValue to value of attribute "AXRole" of itemRef',
            'end try',
            'if roleValue is in supportedRoles then',
            'set combinedText to ""',
            'try',
            'set combinedText to combinedText & " " & my normalizeText(value of attribute "AXTitle" of itemRef)',
            'end try',
            'try',
            'set combinedText to combinedText & " " & my normalizeText(value of attribute "AXDescription" of itemRef)',
            'end try',
            'try',
            'set combinedText to combinedText & " " & my normalizeText(value of attribute "AXRoleDescription" of itemRef)',
            'end try',
            'try',
            'set combinedText to combinedText & " " & my normalizeText(value of attribute "AXIdentifier" of itemRef)',
            'end try',
            'if my matchesAnyTerm(combinedText, primaryTerms) then',
            'return itemRef',
            'end if',
            'if fallbackElement is missing value and my matchesAnyTerm(combinedText, secondaryTerms) then',
            'set fallbackElement to itemRef',
            'end if',
            'end if',
            'try',
            'set childItems to UI elements of itemRef',
            'if (count of childItems) > 0 then',
            'set nestedTarget to my findMatchingPressable(childItems, maxDepth - 1, supportedRoles, primaryTerms, secondaryTerms)',
            'if nestedTarget is not missing value then',
            'return nestedTarget',
            'end if',
            'end if',
            'end try',
            'end repeat',
            'return fallbackElement',
            'end findMatchingPressable',
            'end using terms from',
            'tell application "System Events"',
            'set frontApp to first application process whose frontmost is true',
            'set currentAppName to name of frontApp',
            'set currentBundleId to ""',
            'try',
            'set currentBundleId to bundle identifier of frontApp',
            'end try',
        ]
        if expected_bundle_id:
            escaped_bundle_id = escape_applescript_string(expected_bundle_id)
            script.append(
                f'if currentBundleId is not "{escaped_bundle_id}" then error "The frontmost app changed before the action could run."'
            )
        else:
            escaped_app_name = escape_applescript_string(expected_app_name)
            script.append(
                f'if currentAppName is not "{escaped_app_name}" then error "The frontmost app changed before the action could run."'
            )

        script.extend([
            'if (count of windows of frontApp) = 0 then error "The frontmost app does not expose a window for UI automation."',
            'set rootItems to UI elements of front window of frontApp',
            'set webArea to my findFirstWebArea(rootItems, 8)',
            'if webArea is missing value then error "The browser page did not expose a web area for send-button automation."',
            'set targetElement to missing value',
            'try',
            'set targetElement to my findMatchingPressable((UI elements of webArea), 10, supportedRoles, primaryTerms, secondaryTerms)',
            'end try',
            'if targetElement is missing value then error "The browser page did not expose a page send button."',
            'perform action "AXPress" of targetElement',
            'end tell',
        ])
        return script

    def _build_focused_element_applescript(self) -> list[str]:
        return [
            'set fieldSep to (character id 30)',
            'using terms from application "System Events"',
            'on classifySource(itemRef)',
            'set currentRef to itemRef',
            'repeat 12 times',
            'set roleValue to ""',
            'try',
            'set roleValue to value of attribute "AXRole" of currentRef',
            'end try',
            'if roleValue is "AXWebArea" then',
            'return "page_content"',
            'end if',
            'try',
            'set currentRef to value of attribute "AXParent" of currentRef',
            'on error',
            'exit repeat',
            'end try',
            'end repeat',
            'return "browser_chrome"',
            'end classifySource',
            'end using terms from',
            'tell application "System Events"',
            'set frontApp to first application process whose frontmost is true',
            'set focusedElement to value of attribute "AXFocusedUIElement" of frontApp',
            'set roleValue to ""',
            'set subroleValue to ""',
            'set titleValue to ""',
            'set descriptionValue to ""',
            'set placeholderValue to ""',
            'set roleDescriptionValue to ""',
            'try',
            'set roleValue to value of attribute "AXRole" of focusedElement',
            'end try',
            'try',
            'set subroleValue to value of attribute "AXSubrole" of focusedElement',
            'end try',
            'try',
            'set titleValue to value of attribute "AXTitle" of focusedElement',
            'end try',
            'try',
            'set descriptionValue to value of attribute "AXDescription" of focusedElement',
            'end try',
            'try',
            'set placeholderValue to value of attribute "AXPlaceholderValue" of focusedElement',
            'end try',
            'try',
            'set roleDescriptionValue to value of attribute "AXRoleDescription" of focusedElement',
            'end try',
            'set sourceClass to my classifySource(focusedElement)',
            'return roleValue & fieldSep & subroleValue & fieldSep & titleValue & fieldSep & descriptionValue & fieldSep & placeholderValue & fieldSep & roleDescriptionValue & fieldSep & sourceClass',
            'end tell',
        ]

    def _run_applescript(self, lines: list[str]) -> str:
        return run_applescript_lines(
            lines,
            timeout=self.timeout_sec,
            check=True,
        )

    def _normalize(self, value: Optional[str]) -> Optional[str]:
        normalized = (value or "").strip()
        return normalized or None

    def _parse_pair_value(self, raw_value: Optional[str], index: int) -> Optional[int]:
        parts = [part.strip() for part in str(raw_value or "").split(",")]
        if len(parts) <= index:
            return None
        try:
            return int(float(parts[index]))
        except (TypeError, ValueError):
            return None

    def _verify_primary_chat_input_focus(
        self,
        *,
        expected_app_name: str,
        expected_bundle_id: Optional[str],
    ) -> None:
        focused = self.capture_focused_ui_element()
        logger.info(
            "[UIAutomation] Verified focused UI element for chat input app=%s bundle_id=%s role=%s label=%s placeholder=%s source_class=%s",
            expected_app_name,
            expected_bundle_id,
            focused.role,
            focused.label or focused.description,
            focused.placeholder,
            focused.source_class,
        )
        if focused.source_class != "page_content" or focused.role not in TEXT_FIELD_ROLES:
            raise RuntimeError("The browser focused browser chrome instead of the page chat input.")


def classify_ui_automation_error(message: str) -> str:
    lowered = (message or "").lower()
    if "not permitted" in lowered or "not authorized" in lowered or "access" in lowered:
        return "permission"
    if "syntax error" in lowered or "(-2741)" in lowered:
        return "script_compile"
    if "timed out" in lowered:
        return "timeout"
    if "changed before the action could run" in lowered:
        return "frontmost_changed"
    if "does not expose a window" in lowered:
        return "no_window"
    return "execution"
