export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const notFound = (what = "资源") => new HttpError(404, `${what}不存在`);
export const badRequest = (message) => new HttpError(400, message);

export function assert(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}
