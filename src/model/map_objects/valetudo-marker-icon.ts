// noinspection CssUnresolvedCustomProperty
import { css, CSSResultGroup, SVGTemplateResult } from "lit";

import { Context } from "./context";
import { MapObject } from "./map-object";
import { ValetudoMarker } from "../../lib/valetudo-json-map-source";

export type ValetudoMarkerKind = "robot" | "charger" | "go-to-target";

const ICONS: Record<ValetudoMarkerKind, string> = {
    robot: "mdi:robot-vacuum",
    charger: "mdi:battery-charging",
    "go-to-target": "mdi:map-marker",
};

export class ValetudoMarkerIcon extends MapObject {
    constructor(private readonly _marker: ValetudoMarker, private readonly _kind: ValetudoMarkerKind, context: Context) {
        super(context);
    }

    public render(): SVGTemplateResult {
        return this.renderIcon(
            { x: this._marker.x, y: this._marker.y, name: ICONS[this._kind] },
            () => undefined,
            `valetudo-marker valetudo-marker-${this._kind}`,
        );
    }

    public static get styles(): CSSResultGroup {
        return css`
            .map-icon-wrapper.valetudo-marker {
                x: var(--x-icon);
                y: var(--y-icon);
                height: var(--map-card-internal-valetudo-marker-wrapper-size);
                width: var(--map-card-internal-valetudo-marker-wrapper-size);
                border-radius: 50%;
                transform-box: fill-box;
                overflow: hidden;
                transform: translate(
                        calc(var(--map-card-internal-valetudo-marker-wrapper-size) / -2),
                        calc(var(--map-card-internal-valetudo-marker-wrapper-size) / -2)
                    )
                    scale(calc(1 / var(--map-scale)));
                --mdc-icon-size: var(--map-card-internal-valetudo-marker-icon-size);
                pointer-events: none;
                background: var(--map-card-internal-valetudo-marker-background-color);
                color: var(--map-card-internal-valetudo-marker-icon-color);
            }

            .map-icon-wrapper.valetudo-marker-robot {
                background: var(--map-card-internal-valetudo-robot-background-color);
                color: var(--map-card-internal-valetudo-robot-icon-color);
            }
        `;
    }
}
