import { createLogger } from '../src/infrastructure/logger.js';
import { WhatsAppCloudApiAdapter } from '../src/messaging/whatsapp-cloud-api-adapter.js';

function subject() {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImplementation = vi.fn(async (input: string | URL, init?: RequestInit) => {
    requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    return new Response('{}', { status: 200 });
  });
  const received: unknown[] = [];
  const adapter = new WhatsAppCloudApiAdapter(
    {
      accessToken: 'token-de-prueba-no-real-1234567890',
      phoneNumberId: '123456789012345',
      apiVersion: 'v-test',
      appSecret: 'secreto-de-prueba-no-real',
    },
    createLogger('silent'),
    fetchImplementation,
  );
  adapter.setEvents({
    onMessage: async (message) => { received.push(message); },
    onStateChange: vi.fn(),
    onReady: vi.fn(),
    onQr: vi.fn(),
  });
  return { adapter, requests, received };
}

describe('conector oficial WhatsApp Cloud API', () => {
  it('envía texto, botones y listas al endpoint del número configurado', async () => {
    const { adapter, requests } = subject();
    await adapter.initialize();
    await adapter.sendMessage('56912345678@c.us', 'Hola');
    await expect(adapter.sendInteractiveMenu('56912345678@c.us', {
      title: 'Atención',
      message: '¿Qué necesitas?',
      helpText: '',
      kind: 'buttons',
      options: [{ id: 'products', label: 'Productos' }, { id: 'hours', label: 'Horarios' }],
    })).resolves.toBe(true);
    await expect(adapter.sendInteractiveMenu('56912345678@c.us', {
      title: 'Opciones',
      message: 'Selecciona una opción',
      helpText: '',
      kind: 'list',
      options: Array.from({ length: 5 }, (_, index) => ({ id: `option-${index}`, label: `Opción ${index + 1}` })),
    })).resolves.toBe(true);

    expect(requests).toHaveLength(3);
    expect(requests[0]?.url).toContain('/v-test/123456789012345/messages');
    const bodies = requests.map((request) => JSON.parse(String(request.init?.body)) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ to: '56912345678', type: 'text' });
    expect(bodies[1]).toMatchObject({ type: 'interactive', interactive: { type: 'button' } });
    expect(bodies[2]).toMatchObject({ type: 'interactive', interactive: { type: 'list' } });
  });

  it('adapta solamente mensajes privados de texto y selecciones oficiales', async () => {
    const { adapter, received } = subject();
    await adapter.initialize();
    const count = await adapter.ingestWebhook({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: '123456789012345' },
            messages: [
              { id: 'wamid.text', from: '56912345678', type: 'text', text: { body: 'Hola' } },
              { id: 'wamid.list', from: '56912345678', type: 'interactive', interactive: { list_reply: { id: 'hours', title: 'Horarios' } } },
              { id: 'wamid.image', from: '56912345678', type: 'image', image: { id: 'media' } },
            ],
          },
        }],
      }],
    });

    expect(count).toBe(2);
    expect(received).toMatchObject([
      { id: 'wamid.text', chatId: '56912345678@c.us', body: 'Hola', isGroup: false },
      { id: 'wamid.list', chatId: '56912345678@c.us', body: 'hours', isGroup: false },
    ]);
  });
});
