import { describe, expect, it } from 'vitest';
import { Rational } from '../src/credit/decimal';

describe('exact decimal accounting', () => {
  it('uses canonical parsed numeric values and exact finite products', () => {
    expect(Rational.from(0.1).multiply(1.5).toString()).toBe('0.15');
    expect(Rational.from(0.1).add(0.2).compare(0.3)).toBe(0);
    expect(Rational.from(200).multiply(1.275).toString()).toBe('255');
    expect(Rational.from(0.123456789).toString()).toBe('0.123456789');
    expect(Rational.from(1e21).toString()).toBe('1000000000000000000000');
  });

  it('retains the smallest positive finite number without principal rounding', () => {
    const tiny = Rational.from(Number.MIN_VALUE);
    expect(tiny.compare(0)).toBe(1);
    expect(tiny.toNumber()).toBe(Number.MIN_VALUE);
    expect(tiny.multiply('1.5').toString()).toBe(`0.${'0'.repeat(323)}75`);
    expect(tiny.add('0.1').subtract('0.1').compare(tiny)).toBe(0);
  });

  it('floors limits and rounds scores and multipliers half up using rational remainders', () => {
    expect(Rational.from(1).divide(3).floor(6).toString()).toBe('0.333333');
    expect(Rational.from('1.0000005').roundHalfUp(6).toString()).toBe('1.000001');
    expect(Rational.from('300.5').roundHalfUp(0).toString()).toBe('301');
    expect(Rational.from('-1.0000001').floor(6).toString()).toBe('-1.000001');
    expect(Rational.from('-1.5').roundHalfUp(0).toString()).toBe('-2');
    expect(() => Rational.from(1).divide(3).toString()).toThrow();
  });

  it('rejects invalid retained decimals and arithmetic', () => {
    for (const value of [NaN, Infinity, -Infinity, '', 'NaN', '1/2']) expect(() => Rational.from(value)).toThrow();
    expect(() => Rational.from(1).divide(0)).toThrow();
  });
});
