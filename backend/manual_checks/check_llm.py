from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from providers.llm_factory import LLMFactory


def main():
    print("LLM Factory Test (Groq Llama3)")

    try:
        llm = LLMFactory.get_llm("groq", "llama3-8b-8192", 0.0)
        print("Model generated successfully, invoking test message...")

        response = llm.invoke("Hello! Identify yourself briefly in one sentence.")
        print("\n--- Response ---")
        print(response.content)
    except Exception as e:
        print(f"Failed: {e}")


if __name__ == "__main__":
    main()
