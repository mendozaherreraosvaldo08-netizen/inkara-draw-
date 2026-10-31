/**
 * Revisión de nombres: acentos que casi siempre llevan los nombres y apellidos
 * en México, mayúsculas ("ana lopez" → "Ana López") y espacios de más. Solo
 * sugiere: el usuario decide si corrige.
 */

const ACCENTS: Record<string, string> = Object.fromEntries(
  `María José Jesús Ángel Ángela Ángeles Andrés Inés Raúl Héctor Víctor Rubén Mónica Verónica Sofía Lucía Valentín Joaquín Germán Efraín Iván Simón Adrián Fabián Damián Sebastián Julián Tomás Nicolás Elías Matías Isaías Jerónimo Ramón Román Martín Agustín Benjamín Belén Eréndira Concepción Asunción Guadalupe Bárbara Lázaro Dámaso Abraham Moisés Josué Saúl Noé Óscar Ismael Rafaela Álvaro Félix Fátima Itzél Xóchitl Débora Zoé Noemí Nohemí Leticia Patricia Natalia Rocío Araceli Jazmín Yazmín Ximena Ruth Esaú Darío Mario
García López Pérez González Hernández Martínez Rodríguez Sánchez Ramírez Gómez Díaz Gutiérrez Jiménez Vázquez Velázquez Domínguez Álvarez Fernández Benítez Núñez Muñoz Suárez Méndez Chávez Márquez Juárez Sáenz Báez Páez Ávila Dávila Cortés Ríos Ibáñez Ordóñez Yáñez Galván Beltrán Guzmán Durán Roldán León Zúñiga Rentería Echeverría Hidalgo Rosas Gálvez Téllez Tellez Peláez Rubí Andrade Calderón Colín Cristóbal Ortíz Ruíz Valdés Montaño Patiño Avendaño Quiñones Treviño Escamilla Solís Chávez Jaramillo Ávalos Uribe Méndez Barrón Bermúdez Cázares Cárdenas Cervantes Esquivel Fuentes Garduño Guillén Hinojosa Lázaro Maldonado Medrano Monzón Morán Olvera Pacheco Quintanilla Rendón Robledo Salazar Tapia Ugalde Valdéz Vélez Zamora`
    .split(/\s+/)
    .filter((w) => w && !['Ortíz', 'Ruíz', 'Valdéz', 'Tellez', 'Ismael', 'Rafaela', 'Leticia', 'Patricia', 'Natalia', 'Araceli', 'Ximena', 'Ruth', 'Mario', 'Guadalupe', 'Abraham', 'Andrade', 'Hidalgo', 'Rosas', 'Cervantes', 'Escamilla', 'Esquivel', 'Fuentes', 'Hinojosa', 'Jaramillo', 'Maldonado', 'Medrano', 'Olvera', 'Pacheco', 'Quintanilla', 'Robledo', 'Salazar', 'Tapia', 'Ugalde', 'Uribe', 'Zamora', 'Itzél'].includes(w))
    .map((w) => [strip(w).toLowerCase(), w]),
);

function strip(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'van', 'von']);
const NAME_COLUMNS = ['nombre', 'nombres', 'nombre completo', 'alumno', 'alumna', 'estudiante', 'graduado', 'graduada', 'egresado', 'egresada', 'apellidos', 'nombre del alumno'];

export const isNameColumn = (column: string) => NAME_COLUMNS.includes(strip(column).toLowerCase().trim());

/** Palabra con mayúscula inicial ("lópez" → "López", "MARÍA" → "María"). */
const capital = (w: string) => w.charAt(0).toLocaleUpperCase('es') + w.slice(1).toLocaleLowerCase('es');

export interface NameCheck {
  fixed: string;
  reasons: string[];
}

/** Sugerencia para un nombre, o null si está bien. */
export function checkName(value: string): NameCheck | null {
  const reasons: string[] = [];
  let text = value.replace(/\s+/g, ' ').trim();
  if (text !== value) reasons.push('espacios de más');
  if (!text) return null;
  const letters = text.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '');
  const allLower = letters.length > 2 && letters === letters.toLocaleLowerCase('es');
  const allUpper = letters.length > 3 && letters === letters.toLocaleUpperCase('es');
  const words = text.split(' ');
  // Mayúsculas: todo en minúsculas (o todo en mayúsculas) → Nombre Propio.
  if (allLower || allUpper) {
    text = words.map((w, i) => (i > 0 && PARTICLES.has(w.toLocaleLowerCase('es')) ? w.toLocaleLowerCase('es') : w.split('-').map(capital).join('-'))).join(' ');
    reasons.push(allLower ? 'mayúsculas' : 'todo en mayúsculas');
  }
  // Acentos de nombres y apellidos comunes (solo si la palabra no trae ninguno).
  const accented: string[] = [];
  text = text
    .split(' ')
    .map((w) => {
      const key = w.toLocaleLowerCase('es');
      const target = ACCENTS[key];
      if (!target || strip(w) !== w) return w;
      accented.push(target);
      return w === w.toLocaleUpperCase('es') && w.length > 1 && !(allUpper) ? target.toLocaleUpperCase('es') : target;
    })
    .join(' ');
  if (accented.length) reasons.push(`acento en ${accented.join(', ')}`);
  return text !== value ? { fixed: text, reasons } : null;
}
