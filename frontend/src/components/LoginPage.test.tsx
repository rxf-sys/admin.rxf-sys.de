import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';
import { ApiError } from '../api/client';

describe('LoginPage', () => {
  it('submits the entered credentials', async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    render(<LoginPage onLogin={onLogin} />);

    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'robin' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'secret-pw' } });
    fireEvent.click(screen.getByRole('button', { name: /Anmelden/i }));

    await waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith('robin', 'secret-pw');
    });
  });

  it('shows the server error message on a failed login', async () => {
    const onLogin = vi
      .fn()
      .mockRejectedValue(new ApiError(401, JSON.stringify({ detail: 'Benutzername oder Passwort falsch' })));
    render(<LoginPage onLogin={onLogin} />);

    fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: 'robin' } });
    fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /Anmelden/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Benutzername oder Passwort falsch');
    });
  });
});
