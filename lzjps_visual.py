"""Terminal controller for the LZJPS Node.js Spanish proxy."""

import json
import os
import signal
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

SERVER_URL = os.getenv("LZJPS_SERVER_URL", "http://localhost:3000")
SERVER_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.js")

server_process = None


def show_menu():
    print("\n=== LZJPS Visual Console ===")
    print("1. Power on (spanish)")
    print("2. Power off (english)")
    print("3. Logs and issues")
    print("4. Exit")


def health_check():
    """Return the proxy health payload, or None when it is unreachable."""
    try:
        request = Request(f"{SERVER_URL}/health", method="GET")
        with urlopen(request, timeout=3) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, URLError):
        return None


def power_on_spanish():
    global server_process

    if health_check():
        print("\nSUCCESS: Spanish proxy mechanism is already active.")
        return

    if not os.path.exists(SERVER_FILE):
        print(f"\nERROR: Cannot find {SERVER_FILE}.")
        return

    try:
        server_process = subprocess.Popen(
            ["node", SERVER_FILE],
            cwd=os.path.dirname(SERVER_FILE),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except OSError as error:
        print(f"\nERROR: Could not start Node.js. Is Node installed? ({error})")
        return

    for _ in range(15):
        time.sleep(0.4)
        if health_check():
            print("\nSUCCESS: Spanish proxy mechanism is active.")
            print("Proxy pipeline online: Spanish audio -> Groq Whisper -> 5x1 -> Spanish response.")
            return

    print("\nERROR: Node.js started, but the proxy health check failed.")
    print("Run option 3 to inspect the status.")


def power_off_english():
    global server_process

    if server_process is None or server_process.poll() is not None:
        server_process = None
        print("\nFALLBACK: Standard English behavior activated.")
        print("The Spanish proxy was not running.")
        return

    try:
        if sys.platform == "win32":
            server_process.terminate()
        else:
            os.killpg(os.getpgid(server_process.pid), signal.SIGTERM)
    except (OSError, ProcessLookupError):
        server_process.terminate()

    try:
        server_process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server_process.kill()
        server_process.wait()

    server_process = None
    print("\nFALLBACK: Standard English behavior activated.")
    print("Spanish proxy stopped.")


def logs_and_issues():
    status = health_check()
    print("\n=== Proxy Logs and Connection Status ===")
    print(f"[proxy] Health status: {'ONLINE' if status else 'OFFLINE'} -> {SERVER_URL}/health")
    print(f"[5x1] Configured target: {os.getenv('FIVE_X_ONE_URL', 'https://api.5x1.com:80')}")
    print(f"[groq] API key configured: {'YES' if os.getenv('GROQ_API_KEY') else 'NO'}")
    print(f"[groq] Translator status: {'READY' if os.getenv('GROQ_API_KEY') else 'NOT CONFIGURED'}")
    print(f"[groq] Whisper status: {'READY' if os.getenv('GROQ_API_KEY') else 'NOT CONFIGURED'}")

    if status:
        print(f"[proxy] Response: {status}")
        print("[status] No local connection issues detected.")
    else:
        print("[status] Proxy is not reachable. Use option 1 to start server.js.")


def main():
    try:
        while True:
            show_menu()
            choice = input("Select an option: ").strip()

            if choice == "1":
                power_on_spanish()
            elif choice == "2":
                power_off_english()
            elif choice == "3":
                logs_and_issues()
            elif choice == "4":
                power_off_english()
                print("\nExiting LZJPS Visual Console. Goodbye.")
                break
            else:
                print("\nInvalid option. Please choose 1, 2, 3, or 4.")
    except KeyboardInterrupt:
        print("\nInterrupted. Shutting down LZJPS.")
        power_off_english()


if __name__ == "__main__":
    main()
