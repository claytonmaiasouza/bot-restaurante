/**
 * Transcreve áudio usando OpenAI Whisper.
 * Recebe base64 do áudio (ogg/opus do WhatsApp) e retorna o texto.
 */
async function transcreverAudio(base64Audio, mimeType = "audio/ogg; codecs=opus") {
  const buffer = Buffer.from(base64Audio, "base64");
  const blob = new Blob([buffer], { type: mimeType });

  const form = new FormData();
  form.append("file", blob, "audio.ogg");
  form.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Whisper erro ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.text || "";
}

module.exports = { transcreverAudio };
