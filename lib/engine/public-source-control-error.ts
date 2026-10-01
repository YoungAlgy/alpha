/** Local admission, queue and quota controls are not upstream source failures. */
export class PublicSourceControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicSourceControlError";
  }
}
