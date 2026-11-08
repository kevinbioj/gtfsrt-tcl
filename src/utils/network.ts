/**
 * Le réseau du producteur, le seul qu'il publie. Les identifiants du GTFS de TCL ne portent pas de
 * préfixe de réseau (« C1 », « 33217 ») : c'est cette constante qui range les entités publiées —
 * « TM:TCL:… », « SH:TCL:DEV:… ».
 */
export const NETWORK = "TCL";
