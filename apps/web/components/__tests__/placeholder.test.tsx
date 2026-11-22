import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

function TestBanner({ label }: { label: string }) {
  return <div>{label}</div>;
}

describe('Vitest + React Testing Library setup', () => {
  it('renders a React component and asserts with jest-dom', () => {
    render(<TestBanner label="TariffShield web unit tests ready" />);
    expect(screen.getByText('TariffShield web unit tests ready')).toBeInTheDocument();
  });
});
