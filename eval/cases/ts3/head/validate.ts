export function validateAge(age: number): number {
  if (!Number.isInteger(age) || age < 0 || age > 150) {
    throw new RangeError(`Invalid age: ${age}`);
  }
  return age;
}
