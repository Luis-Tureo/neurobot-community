import type { ThemedDayConfiguration, ThemedDayWeekday } from './themed-day-types.js';

export const THEMED_DAY_TOLERANCE_MINUTES = 60;

type DefaultThemedDay = Omit<ThemedDayConfiguration, 'timezone'>;

export const DEFAULT_THEMED_DAYS: readonly DefaultThemedDay[] = [
  {
    weekday: 1,
    enabled: false,
    name: '🐾 Lunes de mascotas',
    description:
      'Comparte una foto, una anécdota o un momento divertido de tu mascota. Puedes participar cuando te apetezca 💜',
    publishTime: '09:30',
    startTime: '10:00',
    endTime: '22:00',
  },
  {
    weekday: 2,
    enabled: false,
    name: '🎧 Martes de música',
    description:
      '¿Qué canción, artista o playlist te acompaña esta semana? Comparte lo que tienes en repeat 🎶',
    publishTime: '17:30',
    startTime: '18:00',
    endTime: '22:30',
  },
  {
    weekday: 3,
    enabled: false,
    name: '💬 Miércoles de pregunta',
    description:
      'Pregunta de la comunidad: comparte tu respuesta si te apetece. No hay respuestas correctas ni obligación de participar.',
    publishTime: '17:30',
    startTime: '18:00',
    endTime: '22:00',
  },
  {
    weekday: 4,
    enabled: false,
    name: '🧩 Jueves de stickers',
    description:
      'Comparte tu sticker favorito, el más absurdo que tengas o uno que represente perfectamente tu semana 😂',
    publishTime: '17:30',
    startTime: '18:00',
    endTime: '22:00',
  },
  {
    weekday: 5,
    enabled: false,
    name: '😂 Viernes de memes',
    description:
      'Se abre el viernes de memes. Comparte uno que represente tu semana, tu hiperfoco o simplemente algo que te haya hecho reír.',
    publishTime: '16:30',
    startTime: '17:00',
    endTime: '23:00',
  },
  {
    weekday: 6,
    enabled: false,
    name: '🎨 Sábado de hobbies e hiperfocos',
    description:
      'Gaming, dibujo, programación, plantas, historia, colecciones… comparte tu hobby o hiperfoco del momento.',
    publishTime: '11:30',
    startTime: '12:00',
    endTime: '22:00',
  },
  {
    weekday: 7,
    enabled: false,
    name: '🌱 Domingo de pequeños logros',
    description:
      'Comparte algo bueno, curioso o importante de tu semana. Puede ser algo grande o una cosa muy pequeña.',
    publishTime: '17:30',
    startTime: '18:00',
    endTime: '22:00',
  },
] as const;

export const THEMED_DAY_LABELS: Record<ThemedDayWeekday, string> = {
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
  7: 'Domingo',
};
