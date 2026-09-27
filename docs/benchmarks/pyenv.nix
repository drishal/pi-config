let
  # BENCH_FLAKE pins nixpkgs to your own flake's input (e.g. git+file:///home/you/dotfiles);
  # without it, the nixpkgs on NIX_PATH. Build with: nix build --no-link --impure --file <this>
  ref = builtins.getEnv "BENCH_FLAKE";
  pkgs = if ref != "" then (builtins.getFlake ref).inputs.nixpkgs.legacyPackages.${builtins.currentSystem} else import <nixpkgs> { };
in pkgs.python3.withPackages (p: with p; [ typer python-dotenv rich tiktoken rank-bm25 openai httpx google-genai scipy datasets ])
