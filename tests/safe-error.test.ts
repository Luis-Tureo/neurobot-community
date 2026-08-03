import { serializeError } from '../src/infrastructure/safe-error.js';

describe('diagnóstico seguro de errores', () => {
  it('reemplaza nombres minificados de una letra por un código útil', () => {
    const error = new Error('fallo al cargar chats');
    error.name = 'r';
    expect(serializeError(error, 'GROUP_LIST_FETCH_FAILED')).toMatchObject({
      errorName: 'r',
      errorMessage: 'fallo al cargar chats',
      errorCode: 'GROUP_LIST_FETCH_FAILED',
    });
  });

  it('incluye pila en diagnóstico y oculta identificadores sensibles', () => {
    const error = new Error('falló 56912345678@c.us en C:\\privado\\archivo.js');
    const result = serializeError(error, 'SAFE_FAILURE', true);
    expect(result.errorStack).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('56912345678');
    expect(JSON.stringify(result)).not.toContain('privado');
  });
});
