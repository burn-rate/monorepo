/** Exact rational arithmetic. Decimal inputs are never routed through binary arithmetic. */
export class Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;

  constructor(numerator: bigint, denominator = 1n) {
    if (denominator === 0n) throw new RangeError('Zero denominator.');
    if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
    const divisor = gcd(numerator, denominator);
    this.numerator = numerator / divisor;
    this.denominator = denominator / divisor;
  }

  /** Numbers use the canonical decimal representation of the parsed JSON value. */
  static from(value: number | string | Rational): Rational {
    if (value instanceof Rational) return value;
    if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('Expected a finite number.');
    const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
    if (!match) throw new RangeError('Expected a decimal number.');
    const fraction = match[3] ?? '';
    const exponent = Number(match[4] ?? 0) - fraction.length;
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) throw new RangeError('Decimal exponent is out of range.');
    const numerator = BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${fraction}`);
    return exponent >= 0
      ? new Rational(numerator * 10n ** BigInt(exponent))
      : new Rational(numerator, 10n ** BigInt(-exponent));
  }

  add(value: Rational | number | string): Rational {
    const other = Rational.from(value);
    return new Rational(this.numerator * other.denominator + other.numerator * this.denominator, this.denominator * other.denominator);
  }

  subtract(value: Rational | number | string): Rational {
    const other = Rational.from(value);
    return new Rational(this.numerator * other.denominator - other.numerator * this.denominator, this.denominator * other.denominator);
  }

  multiply(value: Rational | number | string): Rational {
    const other = Rational.from(value);
    return new Rational(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  divide(value: Rational | number | string): Rational {
    const other = Rational.from(value);
    return new Rational(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  compare(value: Rational | number | string): -1 | 0 | 1 {
    const other = Rational.from(value);
    const delta = this.numerator * other.denominator - other.numerator * this.denominator;
    return delta < 0n ? -1 : delta > 0n ? 1 : 0;
  }

  floor(places: number): Rational {
    const scale = decimalScale(places);
    const scaled = this.numerator * scale;
    let integer = scaled / this.denominator;
    if (scaled < 0n && scaled % this.denominator !== 0n) integer--;
    return new Rational(integer, scale);
  }

  roundHalfUp(places: number): Rational {
    const scale = decimalScale(places);
    const scaled = abs(this.numerator) * scale;
    const integer = scaled / this.denominator + (scaled % this.denominator * 2n >= this.denominator ? 1n : 0n);
    return new Rational(this.numerator < 0n ? -integer : integer, scale);
  }

  /** Only finite decimal results can be serialized as authoritative stored terms. */
  toString(): string {
    if (this.numerator === 0n) return '0';
    let denominator = this.denominator;
    let twos = 0;
    let fives = 0;
    while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
    while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
    if (denominator !== 1n) throw new RangeError('A repeating rational has no finite decimal representation.');
    const places = Math.max(twos, fives);
    const integer = abs(this.numerator) * 2n ** BigInt(places - twos) * 5n ** BigInt(places - fives);
    const digits = integer.toString().padStart(places + 1, '0');
    const decimal = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/0+$/, '').replace(/\.$/, '') : digits;
    return `${this.numerator < 0n ? '-' : ''}${decimal}`;
  }

  toNumber(): number {
    const result = Number(this.toString());
    if (!Number.isFinite(result)) throw new RangeError('Decimal cannot be represented by a finite wire number.');
    return result;
  }
}

function abs(value: bigint): bigint { return value < 0n ? -value : value; }
function gcd(left: bigint, right: bigint): bigint {
  left = abs(left);
  while (right !== 0n) { const remainder = left % right; left = right; right = remainder; }
  return left;
}
function decimalScale(places: number): bigint {
  if (!Number.isInteger(places) || places < 0 || places > 10000) throw new RangeError('Invalid decimal precision.');
  return 10n ** BigInt(places);
}
