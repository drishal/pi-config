# Temporary benchmark env: AMB's deps + mem0ai (not in nixpkgs), built from the PyPI wheel.
let
  # BENCH_FLAKE pins nixpkgs to your own flake's input (e.g. git+file:///home/you/dotfiles);
  # without it, the nixpkgs on NIX_PATH. Build with: nix build --no-link --impure --file <this>
  ref = builtins.getEnv "BENCH_FLAKE";
  pkgs = if ref != "" then (builtins.getFlake ref).inputs.nixpkgs.legacyPackages.${builtins.currentSystem} else import <nixpkgs> { };
  py = pkgs.python3Packages;
  mem0ai = py.buildPythonPackage rec {
    pname = "mem0ai";
    version = "2.2.1";
    format = "wheel";
    src = pkgs.fetchurl {
      url = "https://files.pythonhosted.org/packages/py3/m/mem0ai/mem0ai-${version}-py3-none-any.whl";
      sha256 = "fe91bb91ac8926231993a4aa58df00a60c6c74c709e6a338fe399500776eef4d";
    };
    dependencies = with py; [ httpx openai posthog protobuf pydantic pytz qdrant-client sqlalchemy ];
    dontCheckRuntimeDeps = true;
    # mem0 creates ~/.mem0 at import, which the build sandbox forbids; the import is tested outside.
  };
in pkgs.python3.withPackages (p: with p; [ typer python-dotenv rich tiktoken rank-bm25 openai httpx google-genai scipy datasets mem0ai ])
