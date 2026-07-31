import { Fragment } from "react";

import { characterIconUrl } from "@/characterIcon";
import { renderTemplateNodes, type TemplateTokens } from "@/labelTemplate";
import { PLAYER_NODE_TOKENS } from "@/utils";

export type PlayerLabelProps = {
  template: string;
  tokens: TemplateTokens;
};

/**
 * A player label rendered from its template, with `{icon}` drawn as an image.
 *
 * The icon is resolved to a URL BEFORE the template renders, and blanked when
 * there is no art for that character. That ordering is the point: an icon that
 * cannot be drawn has to reach the engine as an empty token so the collapse
 * rules remove whatever punctuation was decorating it. Dropping the image at
 * render time instead would leave `()` behind.
 */
export const PlayerLabel = ({ template, tokens }: PlayerLabelProps) => {
  const iconUrl = tokens.icon ? characterIconUrl(tokens.icon) : undefined;
  const resolved = iconUrl ? tokens : { ...tokens, icon: "" };

  return (
    <>
      {renderTemplateNodes(template, resolved, PLAYER_NODE_TOKENS).map((part, index) =>
        part.type === "text" ? (
          <Fragment key={index}>{part.value}</Fragment>
        ) : (
          <img key={index} className="player-label-icon" src={iconUrl} alt="" />
        )
      )}
    </>
  );
};
