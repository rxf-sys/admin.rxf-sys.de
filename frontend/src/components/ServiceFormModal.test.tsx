import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServiceFormModal } from './ServiceFormModal';

vi.mock('../api/client', () => ({
  api: {
    createService: vi.fn().mockResolvedValue({ service: {} }),
    updateService: vi.fn().mockResolvedValue({ service: {} }),
  },
  apiErrorMessage: (e: unknown) => String(e),
}));

import { api } from '../api/client';

const createService = vi.mocked(api.createService);
const updateService = vi.mocked(api.updateService);

describe('ServiceFormModal', () => {
  it('creates a service from valid input', async () => {
    createService.mockClear();
    const onSaved = vi.fn();
    render(
      <ServiceFormModal mode="create" onClose={vi.fn()} onSaved={onSaved} onError={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Grafana' } });
    fireEvent.change(screen.getByLabelText('Interne URL'), {
      target: { value: 'http://192.168.2.50:3000' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Service anlegen/ }));

    await waitFor(() => expect(createService).toHaveBeenCalledTimes(1));
    expect(createService.mock.calls[0][0]).toMatchObject({
      name: 'Grafana',
      internal_url: 'http://192.168.2.50:3000',
      ext_url: null,
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('rejects an invalid internal URL without calling the API', () => {
    createService.mockClear();
    const onError = vi.fn();
    render(
      <ServiceFormModal mode="create" onClose={vi.fn()} onSaved={vi.fn()} onError={onError} />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText('Interne URL'), { target: { value: 'ftp://nope' } });
    fireEvent.click(screen.getByRole('button', { name: /Service anlegen/ }));

    expect(onError).toHaveBeenCalled();
    expect(createService).not.toHaveBeenCalled();
  });

  it('patches the service in edit mode', async () => {
    updateService.mockClear();
    const onSaved = vi.fn();
    render(
      <ServiceFormModal
        mode="edit"
        editId="custom-abc123"
        initial={{
          name: 'Old',
          internal_url: 'http://10.0.0.1',
          icon: 'monitor',
          desc: '',
          ext_url: '',
        }}
        onClose={vi.fn()}
        onSaved={onSaved}
        onError={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: /Änderungen speichern/ }));

    await waitFor(() => expect(updateService).toHaveBeenCalledTimes(1));
    expect(updateService.mock.calls[0][0]).toBe('custom-abc123');
    expect(updateService.mock.calls[0][1]).toMatchObject({ name: 'New' });
    expect(onSaved).toHaveBeenCalled();
  });
});
