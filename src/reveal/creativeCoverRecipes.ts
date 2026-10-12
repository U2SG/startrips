import definitions from "./creativeCoverRecipes.json";

export type CreativeCoverRecipeId = "ink-wash-memory" | "poetic-line-memory" | "paper-collage-memory";
export type CreativeCoverRecipe = Omit<typeof definitions[number], "id"> & { id: CreativeCoverRecipeId };
export const CREATIVE_COVER_RECIPES: readonly Readonly<CreativeCoverRecipe>[] = Object.freeze(
  definitions.map((recipe) => Object.freeze({ ...recipe, id: recipe.id as CreativeCoverRecipeId })),
);
export function creativeCoverRecipe(id: unknown): Readonly<CreativeCoverRecipe> | null {
  return CREATIVE_COVER_RECIPES.find((recipe) => recipe.id === id) ?? null;
}
export function creativeCoverRecipeForGeneration(kind: unknown, version: unknown): Readonly<CreativeCoverRecipe> | null {
  return CREATIVE_COVER_RECIPES.find((recipe) => recipe.generationKind === kind && recipe.version === version) ?? null;
}
