import { THEMED_DAY_KEYS, type ThemedDayKey, type ThemedDaySettings } from './themed-day-types.js';

export const DEFAULT_THEMED_DAY_SETTINGS: Record<ThemedDayKey, ThemedDaySettings> = {
  monday: {
    key: 'monday',
    enabled: false,
    startTime: '10:00',
    title: '🐾 Lunes de mascotas',
    description:
      'Comparte una foto, una anécdota o un momento divertido de tu mascota. Participa sólo si te apetece 💜',
    imagePath: null,
  },
  tuesday: {
    key: 'tuesday',
    enabled: false,
    startTime: '18:00',
    title: '🎧 Martes de música',
    description:
      '¿Qué canción tienes en repeat esta semana? Comparte una canción, artista o playlist que te esté acompañando.',
    imagePath: null,
  },
  wednesday: {
    key: 'wednesday',
    enabled: false,
    startTime: '18:00',
    title: '💬 Miércoles de pregunta',
    description:
      'Pregunta de la comunidad: comparte algo sobre tu semana, tus intereses o aquello que te esté haciendo bien. Participar es opcional.',
    imagePath: null,
  },
  thursday: {
    key: 'thursday',
    enabled: false,
    startTime: '18:00',
    title: '🧩 Jueves de stickers',
    description:
      'Comparte tu sticker favorito, el más absurdo que tengas o uno que represente perfectamente tu semana 😂',
    imagePath: null,
  },
  friday: {
    key: 'friday',
    enabled: false,
    startTime: '17:00',
    title: '😂 Viernes de memes',
    description:
      'Comparte un meme que represente tu semana, tu hiperfoco o simplemente algo que te haya hecho reír. Mantengamos el contenido acorde a las reglas.',
    imagePath: null,
  },
  saturday: {
    key: 'saturday',
    enabled: false,
    startTime: '12:00',
    title: '🎨 Sábado de hobbies e hiperfocos',
    description:
      'Gaming, dibujo, programación, plantas, historia, colecciones… comparte aquello que te entusiasma últimamente.',
    imagePath: null,
  },
  sunday: {
    key: 'sunday',
    enabled: false,
    startTime: '19:00',
    title: '🌱 Domingo de pequeños logros',
    description:
      '¿Qué cosa buena, curiosa o importante te pasó esta semana? Puede ser algo grande o muy pequeño. Participa sólo si te apetece.',
    imagePath: null,
  },
};

export function defaultThemedDays(): ThemedDaySettings[] {
  return THEMED_DAY_KEYS.map((key) => ({ ...DEFAULT_THEMED_DAY_SETTINGS[key] }));
}
