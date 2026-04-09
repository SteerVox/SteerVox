from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.skills.defaults import DefaultSkills
from agent.supervisor import SupervisorAgent


def main():
    print("Testing Supervisor Agent...")

    agent = SupervisorAgent()

    print("\n--- Scenario 1: Terminal Context (Dictation) ---")
    raw_transcript = "list all files in the current directory"
    os_context = {
        "app_name": "Terminal",
        "window_title": "zsh",
        "page_title": None,
        "url_host": None,
    }

    response = agent.process_transcript(raw_transcript, os_context, DefaultSkills.DICTATION)
    print(f"Transcript: '{raw_transcript}'")
    print(f"Active App: {os_context['app_name']}")
    print(f"Result:\n{response.text}")

    print("\n--- Scenario 2: Markdown File (Dictation) ---")
    raw_transcript = "create a level 2 header called feature list followed by bullet points for fast and secure"
    os_context_md = {
        "app_name": "Code",
        "window_title": "README.md",
        "page_title": None,
        "url_host": None,
    }

    response_md = agent.process_transcript(raw_transcript, os_context_md, DefaultSkills.DICTATION)
    print(f"Transcript: '{raw_transcript}'")
    print(f"Active App: {os_context_md['app_name']} ({os_context_md['window_title']})")
    print(f"Result:\n{response_md.text}")

    print("\n--- Scenario 3: Slack (Grammar Fix) ---")
    raw_transcript = "hey man im gonna b late for the meeting today cause of traffic."
    os_context_slack = {
        "app_name": "Slack",
        "window_title": "engineering-channel",
        "page_title": None,
        "url_host": None,
    }

    response_slack = agent.process_transcript(raw_transcript, os_context_slack, DefaultSkills.GRAMMAR_FIX)
    print(f"Transcript: '{raw_transcript}'")
    print(f"Active App: {os_context_slack['app_name']}")
    print(f"Result:\n{response_slack.text}")

    print("\n--- Scenario 4: Browser Context (Dictation) ---")
    raw_transcript_browser = "summarize the rollout steps for this page"
    os_context_browser = {
        "app_name": "Safari",
        "window_title": "Releases - docs.example.com",
        "page_title": "Release checklist",
        "url_host": "docs.example.com"
    }

    response_browser = agent.process_transcript(raw_transcript_browser, os_context_browser, DefaultSkills.DICTATION)
    print(f"Transcript: '{raw_transcript_browser}'")
    print(f"Active App: {os_context_browser['app_name']} ({os_context_browser['url_host']})")
    print(f"Result:\n{response_browser.text}")


if __name__ == "__main__":
    main()
