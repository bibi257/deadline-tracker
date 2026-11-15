export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export async function readJson(request, maxChars) {
  const text = await request.text();
  if (text.length > maxChars) throw new HttpError(413, 'データが大きすぎます');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, '送られたデータの形式が正しくありません');
  }
}
