import { createLogger, createPrettyStream } from '../src/infrastructure/logger.js';

describe('sistema de logger y formato amigable', () => {
  it('genera JSON estructurado en modo producción', () => {
    let output = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });

    try {
      const logger = createLogger('info', false);
      logger.info({ operation: 'TEST_OP', detail: 'ejemplo' }, 'Mensaje de prueba');

      expect(output).toContain('"msg":"Mensaje de prueba"');
      expect(output).toContain('"operation":"TEST_OP"');
      expect(output).toContain('"level":30');
    } finally {
      spy.mockRestore();
    }
  });

  it('genera formato amigable con módulo y UTF-8 en modo desarrollo', () => {
    let output = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });

    try {
      const logger = createLogger('info', true);
      logger.info(
        {
          operation: 'getChats',
          detectedGroups: 8,
          skippedChats: 9,
          source: 'MINIMAL_CHAT_SNAPSHOT',
          summary: { active: 3, temporaryErrors: 9 },
        },
        'Lista de grupos actualizada: falló; intentará una lectura mínima compatible',
      );

      expect(output).toContain('INFO');
      expect(output).toContain('[WhatsApp]');
      expect(output).toContain('Lista de grupos actualizada: falló; intentará una lectura mínima compatible');
      expect(output).toContain('Grupos detectados: 8');
      expect(output).toContain('Chats omitidos: 9');
      expect(output).toContain('Fuente: MINIMAL_CHAT_SNAPSHOT');
      expect(output).toContain('Activos: 3');
      expect(output).toContain('Errores temporales: 9');
      expect(output).not.toContain('├│');
    } finally {
      spy.mockRestore();
    }
  });

  it('presenta un skip de bienvenida con mensaje y motivo humanos', () => {
    let output = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });

    try {
      const logger = createLogger('info', true);
      logger.warn(
        {
          module: 'Bienvenida',
          operation: 'WELCOME_SKIPPED',
          reason: 'grupo no seleccionado para automatizaciones',
          groupName: 'Comunidad Neurodivergente',
          participantCount: 1,
        },
        'Bienvenida omitida',
      );

      expect(output).toContain('WARN');
      expect(output).toContain('[Bienvenida] Bienvenida omitida');
      expect(output).toContain('Motivo: grupo no seleccionado para automatizaciones');
      expect(output).toContain('Grupo: Comunidad Neurodivergente');
      expect(output).toContain('Participantes: 1');
      expect(output).not.toContain('{"level"');
    } finally {
      spy.mockRestore();
    }
  });

  it('mantiene compacto un warning recuperable y deja el stack fuera de INFO', () => {
    let output = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });

    try {
      const logger = createLogger('info', true);
      logger.warn(
        {
          module: 'WhatsApp',
          operation: 'getChats',
          fallback: 'minimalChatSnapshot',
          recovery: 'Se utilizará una lectura mínima compatible',
          errorCode: 'GROUP_LIST_FETCH_FAILED',
          errorStack: 'Error: fallo\n at detalle-privado.js:1',
        },
        'No se pudo obtener la lista completa de chats',
      );
      expect(output).toContain('[WhatsApp] No se pudo obtener la lista completa de chats');
      expect(output).toContain('Se utilizará una lectura mínima compatible');
      expect(output).not.toContain('detalle-privado');
    } finally {
      spy.mockRestore();
    }
  });

  it('sanitiza datos sensibles como apiKey, token, password y cookie', () => {
    let output = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });

    try {
      const logger = createLogger('info', false);
      logger.info(
        {
          apiKey: 'secret_groq_key_123',
          password: 'super_secret_password',
          token: 'jwt_token_xyz',
          normalField: 'visible_data',
        },
        'Prueba de sanitización',
      );

      expect(output).toContain('[OCULTO]');
      expect(output).not.toContain('secret_groq_key_123');
      expect(output).not.toContain('super_secret_password');
      expect(output).not.toContain('jwt_token_xyz');
      expect(output).toContain('visible_data');
    } finally {
      spy.mockRestore();
    }
  });

  it('condensa stack trace en nivel ERROR y lo incluye completo en nivel DEBUG', () => {
    let infoOutput = '';
    let debugOutput = '';

    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      infoOutput += String(chunk);
      return true;
    });

    try {
      const loggerInfo = createLogger('info', true);
      loggerInfo.error(
        {
          operation: 'testError',
          errorMessage: 'Execution context error',
          errorCode: 'TEST_ERROR',
          errorStack: 'Error: Execution context error\n    at testFunction (file.js:10)',
        },
        'No se pudieron obtener los chats',
      );
      expect(infoOutput).toContain('ERROR');
      expect(infoOutput).toContain('No se pudieron obtener los chats');
      expect(infoOutput).toContain('Error: Execution context error');
      expect(infoOutput).not.toContain('Stack trace:');
    } finally {
      spy.mockRestore();
    }

    const spy2 = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      debugOutput += String(chunk);
      return true;
    });

    try {
      const loggerDebug = createLogger('debug', true);
      loggerDebug.error(
        {
          operation: 'testError',
          errorMessage: 'Execution context error',
          errorCode: 'TEST_ERROR',
          errorStack: 'Error: Execution context error\n    at testFunction (file.js:10)',
        },
        'No se pudieron obtener los chats',
      );
      expect(debugOutput).toContain('Stack trace:');
      expect(debugOutput).toContain('at testFunction (file.js:10)');
    } finally {
      spy2.mockRestore();
    }
  });

  it('manejador del prettyStream no falla si faltan campos opcionales', () => {
    let output = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });

    try {
      const stream = createPrettyStream('info');
      stream.write(JSON.stringify({ level: 30, msg: 'Mensaje simple' }));
      expect(output).toContain('INFO');
      expect(output).toContain('[Servidor]');
      expect(output).toContain('Mensaje simple');
    } finally {
      spy.mockRestore();
    }
  });
});
