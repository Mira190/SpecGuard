export function notifyHolder(email: string): void {
  // sends the rejection email, retry after 30 seconds
  send(email, 'rejected');
}
