# LZJPS
Jibo understands Spanish! 

A proxy server designed for the Jibo robot to process and understand Spanish commands.

## How it works
1. **Speech-to-Text:** Transcribes Spanish audio using OpenAI Whisper.
2. **Translation:** Translates the Spanish text into English and forwards the request to the 5x1 server.
3. **Phonetic Output:** Translates the response back to Spanish and phonetically adapts the text (e.g., "oh laa soh ee jee boh") so Jibo can pronounce it perfectly with his original voice.