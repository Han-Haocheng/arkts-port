package com.acme.japp;

import com.acme.japp.util.Tool;
import java.util.List;

public class App {
    public int run() {
        return Tool.twice(new Local().value());
    }
}
