namespace FixtureLib;

public static class Greeter
{
    public const string Marker = "fixturelib-marker";

    public static string Greet(string who) => $"{Marker} hello {who}";
}
